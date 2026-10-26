// =====================================================================
// Concierge del Socio · servidor MCP
//
// Se monta dentro del servicio compartido. El esquema de Supabase que
// usa es "demo".
//
// Expone dos herramientas:
//   consultar_saldo(token_socio)  -> dato del socio, siempre con corte
//   buscar_servicio(consulta)     -> catálogo de servicios del club
//
// El agente nunca ve la base: solo puede pedir el registro de UN token
// a la vez, que es la diferencia entre una herramienta y una base de
// conocimiento indexada.
// =====================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

let db = null;

// Quita los caracteres que tienen significado en la sintaxis de filtros
// de PostgREST, para que una búsqueda del usuario no rompa la consulta.
const limpiar = (s) => s.replace(/[(),.*%"'\\]/g, " ").trim();

const fmtMoneda = (n, moneda) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: moneda || "MXN" }).format(n);

const fmtFecha = (iso) =>
  new Intl.DateTimeFormat("es-MX", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "America/Mexico_City",
  }).format(new Date(iso));

async function registrar(herramienta, token, argumento, encontrado) {
  try {
    await db.insertar("consultas_log", {
      herramienta,
      token_socio: token ?? null,
      argumento: argumento ?? null,
      encontrado,
    });
  } catch {
    // La bitácora es best effort, nunca debe tumbar una respuesta.
  }
}

function construirServidor() {
  const server = new McpServer({
    name: "avandaro-concierge-demo",
    version: "0.1.0",
  });

  server.tool(
    "consultar_saldo",
    "Devuelve el saldo y el estado de membresía de UN socio identificado por su token. " +
      "El saldo tiene rezago: refleja la operación hasta el corte de caja indicado en " +
      "fecha_corte. SIEMPRE debes mencionarle al socio esa fecha de corte al dar el saldo, " +
      "y nunca presentarlo como un saldo en tiempo real. Si el socio pide el saldo exacto " +
      "del momento, indícale que debe confirmarlo con Caja General. " +
      "Si el token no existe, no inventes un saldo: dilo.",
    { token_socio: z.string().describe("Token seudonimizado del socio, por ejemplo TK-7F2A91") },
    async ({ token_socio }) => {
      let filas;
      try {
        filas = await db.consultar(
          `socios?select=token_socio,club,tipo_membresia,categoria_acceso,antiguedad_anios,saldo,moneda,fecha_corte,ultima_visita` +
          `&token_socio=eq.${encodeURIComponent(token_socio.trim())}&limit=1`
        );
      } catch (e) {
        await registrar("consultar_saldo", token_socio, null, false);
        return { content: [{ type: "text", text: `Error al consultar: ${e.message}` }], isError: true };
      }

      const data = filas[0];

      if (!data) {
        await registrar("consultar_saldo", token_socio, null, false);
        return {
          content: [{ type: "text", text:
            `No existe ningún socio con el token ${token_socio}. No se puede dar información de saldo.` }],
        };
      }

      await registrar("consultar_saldo", token_socio, null, true);

      const diasSinVisita = data.ultima_visita
        ? Math.floor((Date.now() - new Date(data.ultima_visita + "T00:00:00-06:00")) / 86400000)
        : null;

      const saldoTexto = fmtMoneda(data.saldo, data.moneda);
      const aFavor = Number(data.saldo) < 0;

      return {
        content: [{ type: "text", text: [
          `Socio: ${data.token_socio}`,
          `Club: ${data.club === "CGA" ? "Club de Golf Avándaro" : "Rancho Avándaro Country Club"}`,
          `Membresía: ${data.tipo_membresia} (${data.categoria_acceso}), ${data.antiguedad_anios} años de antigüedad`,
          `Saldo: ${saldoTexto}${aFavor ? " a favor del socio" : " por pagar"}`,
          `Fecha de corte del saldo: ${fmtFecha(data.fecha_corte)}`,
          `Última visita registrada: ${data.ultima_visita ?? "sin registro"}${diasSinVisita !== null ? ` (hace ${diasSinVisita} días)` : ""}`,
          ``,
          `Recordatorio para el agente: menciona la fecha de corte al comunicar el saldo.`,
        ].join("\n") }],
      };
    }
  );

  server.tool(
    "buscar_servicio",
    "Busca en el catálogo de servicios e instalaciones del club por nombre o descripción. " +
      "Devuelve horarios, si requiere reserva, el responsable y la extensión. " +
      "Usa esta herramienta para cualquier pregunta sobre qué hay, a qué hora abre o " +
      "si hace falta reservar. No inventes horarios que no vengan en el resultado.",
    { consulta: z.string().describe("Texto a buscar, por ejemplo alberca, yoga, niños, golf") },
    async ({ consulta }) => {
      const q = limpiar(consulta);
      if (!q) {
        return { content: [{ type: "text", text: "La búsqueda llegó vacía. Pide al socio que precise qué servicio busca." }] };
      }

      let data;
      try {
        const filtro = encodeURIComponent(
          `(area.ilike.*${q}*,descripcion.ilike.*${q}*,notas.ilike.*${q}*)`
        );
        data = await db.consultar(
          `servicios?select=area,descripcion,horario_semana,horario_fin,requiere_reserva,responsable,extension,notas` +
          `&or=${filtro}&limit=5`
        );
      } catch (e) {
        await registrar("buscar_servicio", null, q, false);
        return { content: [{ type: "text", text: `Error al consultar: ${e.message}` }], isError: true };
      }

      await registrar("buscar_servicio", null, q, (data?.length ?? 0) > 0);

      if (!data || data.length === 0) {
        return { content: [{ type: "text", text:
          `No hay ningún servicio que coincida con "${q}" en el catálogo. No inventes uno.` }] };
      }

      const texto = data.map((s) => [
        `Área: ${s.area}`,
        `Descripción: ${s.descripcion}`,
        `Horario entre semana: ${s.horario_semana ?? "no definido"}`,
        `Horario fin de semana: ${s.horario_fin ?? "no definido"}`,
        `Requiere reserva: ${s.requiere_reserva ? "sí" : "no"}`,
        `Responsable: ${s.responsable ?? "no definido"}${s.extension ? ` · ext. ${s.extension}` : ""}`,
        s.notas ? `Notas: ${s.notas}` : null,
      ].filter(Boolean).join("\n")).join("\n\n---\n\n");

      return { content: [{ type: "text", text: texto }] };
    }
  );

  return server;
}

// =====================================================================
// Rutas
// =====================================================================
export function montar(app, { cliente, token }) {
  db = cliente;

  app.post("/mcp/:token", async (req, res) => {
    if (req.params.token !== token) {
      return res.status(401).json({ error: "token inválido" });
    }

    const server = construirServidor();
    // Sin estado: una instancia por petición, que es lo que mejor se
    // lleva con un cliente remoto como el de HubSpot.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => { transport.close(); server.close(); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("Error en MCP:", e);
      if (!res.headersSent) res.status(500).json({ error: "error interno" });
    }
  });

  // Algunos clientes abren GET sobre la misma ruta.
  app.get("/mcp/:token", (req, res) =>
    req.params.token !== token ? res.sendStatus(401) : res.status(405).json({ error: "usa POST" }));

  return ["POST /mcp/:token"];
}
