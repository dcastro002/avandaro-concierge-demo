// =====================================================================
// Capa de acceso a Supabase por API REST (PostgREST).
//
// Sin SDK a propósito: el cliente oficial arrastra realtime, que exige
// WebSocket y nos reventó el despliegue en Railway hace tres semanas.
// Con fetch plano la imagen queda más ligera y no hay sorpresas de
// versión de Node.
//
// Cada módulo pide su cliente con el esquema que le toca: el Cotizador
// usa "cot" y el Concierge usa "demo". Los dos esquemas tienen que estar
// expuestos en Settings, API, Exposed schemas, o PostgREST contesta
// PGRST106 y la ruta parece no existir.
// =====================================================================

export function crearCliente(urlBase, llave, esquema) {
  // El dominio va pelón. Un /rest/v1 duplicado fue el origen del
  // PGRST125 que nos costó media hora la primera vez.
  const REST = `${urlBase.replace(/\/+$/, "")}/rest/v1`;

  const cabeceras = (escritura = false) => ({
    apikey: llave,
    Authorization: `Bearer ${llave}`,
    "Content-Type": "application/json",
    [escritura ? "Content-Profile" : "Accept-Profile"]: esquema,
  });

  async function consultar(ruta) {
    const r = await fetch(`${REST}/${ruta}`, { headers: cabeceras() });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    return r.json();
  }

  async function insertar(tabla, fila) {
    const r = await fetch(`${REST}/${tabla}`, {
      method: "POST",
      headers: { ...cabeceras(true), Prefer: "return=minimal" },
      body: JSON.stringify(fila),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  }

  // Alta o actualización en un solo viaje. La usa el hilo de WhatsApp,
  // que reescribe el estado de la conversación en cada mensaje.
  async function guardar(tabla, fila, conflicto) {
    const q = conflicto ? `?on_conflict=${encodeURIComponent(conflicto)}` : "";
    const r = await fetch(`${REST}/${tabla}${q}`, {
      method: "POST",
      headers: { ...cabeceras(true), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(fila),
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  }

  // PostgREST publica un OpenAPI en la raíz de cada esquema. Se usa para
  // descubrir qué vistas existen y qué columnas de texto tienen, en vez
  // de escribir nombres a mano que después cambian cuando alguien
  // reorganiza la base.
  async function describir() {
    const r = await fetch(`${REST}/`, { headers: cabeceras() });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const spec = await r.json();
    const defs = spec.definitions || spec.components?.schemas || {};
    const salida = {};
    for (const [tabla, def] of Object.entries(defs)) {
      const props = def.properties || {};
      salida[tabla] = {
        columnas: Object.keys(props),
        texto: Object.entries(props)
          .filter(([, p]) => p.type === "string" && !/date|time/i.test(p.format || ""))
          .map(([c]) => c),
      };
    }
    return salida;
  }

  // Comprueba que el esquema esté expuesto y que la llave sirva, antes
  // de que lo descubra HubSpot en medio de una demo.
  async function verificar(tabla) {
    try {
      await consultar(`${tabla}?select=*&limit=1`);
      return { ok: true };
    } catch (e) {
      return { ok: false, detalle: e.message.slice(0, 200) };
    }
  }

  return { esquema, consultar, insertar, guardar, describir, verificar };
}
