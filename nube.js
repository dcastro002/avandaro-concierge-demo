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

  return { esquema, consultar, insertar, verificar };
}
