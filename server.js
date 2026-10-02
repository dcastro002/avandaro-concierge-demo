// =====================================================================
// Servidor MCP · Prueba dummy del Concierge del Socio
//
// Expone dos herramientas al agente de HubSpot:
//   consultar_saldo(token_socio)  -> dato del socio, siempre con fecha de corte
//   buscar_servicio(consulta)     -> catálogo de servicios del club
//
// El agente nunca ve la base. Solo puede pedir el registro de UN token
// a la vez, que es la diferencia entre una herramienta y una base de
// conocimiento indexada.
// =====================================================================

import express from "express";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  MCP_TOKEN,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY, MCP_TOKEN })) {
  if (!v) {
    console.error(`Falta la variable de entorno ${k}`);
    process.exit(1);
  }
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  db: { schema: "demo" },
  auth: { persistSession: false },
});

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
    await db.from("consultas_log").insert({
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
      const { data, error } = await db
        .from("socios")
        .select("token_socio, club, tipo_membresia, categoria_acceso, antiguedad_anios, saldo, moneda, fecha_corte, ultima_visita")
        .eq("token_socio", token_socio)
        .maybeSingle();

      if (error) {
        await registrar("consultar_saldo", token_socio, null, false);
        return { content: [{ type: "text", text: `Error al consultar: ${error.message}` }], isError: true };
      }

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
      const q = consulta.trim();
      const { data, error } = await db
        .from("servicios")
        .select("area, descripcion, horario_semana, horario_fin, requiere_reserva, responsable, extension, notas")
        .or(`area.ilike.%${q}%,descripcion.ilike.%${q}%,notas.ilike.%${q}%`)
        .limit(5);

      if (error) {
        await registrar("buscar_servicio", null, q, false);
        return { content: [{ type: "text", text: `Error al consultar: ${error.message}` }], isError: true };
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

// ---------------------------------------------------------------------
// Transporte HTTP. Sin estado: una instancia por petición, que es lo que
// mejor se lleva con un cliente remoto como el de HubSpot.
// ---------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/", (_req, res) => res.json({ ok: true, servicio: "avandaro-concierge-demo" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/mcp/:token", async (req, res) => {
  if (req.params.token !== MCP_TOKEN) {
    return res.status(401).json({ error: "token inválido" });
  }

  const server = construirServidor();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // modo sin estado
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Error en MCP:", e);
    if (!res.headersSent) res.status(500).json({ error: "error interno" });
  }
});

// Algunos clientes abren GET o DELETE sobre la misma ruta.
app.get("/mcp/:token", (req, res) => {
  if (req.params.token !== MCP_TOKEN) return res.sendStatus(401);
  res.status(405).json({ error: "usa POST" });
});

app.listen(PORT, () => {
  console.log(`Servidor MCP escuchando en el puerto ${PORT}`);
  console.log(`Ruta: POST /mcp/<MCP_TOKEN>`);
});
