// =====================================================================
// Banco de pruebas del Cotizador.
//
// Levanta un PostgREST falso con el mismo tarifario que esquema_cotizador.sql,
// arranca el servidor real contra él y corre escenarios. Así se prueba el
// motor completo (HTTP incluido) sin depender de Supabase.
//
// Correr con:  node prueba.js
//
// Monta solo el Cotizador: no pasa MCP_TOKEN, así que el Concierge
// queda fuera y la prueba es del motor de cotización.
// =====================================================================

import http from "node:http";
import { spawn } from "node:child_process";

// Espejo de los datos de esquema_cotizador.sql. Lo que se valida aquí es
// el MOTOR; el tarifario se valida al cargarlo en Supabase.
const DATOS = {
  parametros: [
    { clave: "iva", valor: 0.16, confirmado: true },
    { clave: "ish", valor: 0.04, confirmado: true },
    { clave: "servicio", valor: 0.15, confirmado: true },
    // Bloques de salón: así cobra el hotel la renta de espacio.
    { clave: "salon_bloque_personas", valor: 25, confirmado: true },
    { clave: "salon_bloque_precio", valor: 9500, confirmado: true },
    { clave: "vigencia_dias", valor: 15, confirmado: false },
    { clave: "anticipo_pct", valor: 0.5, confirmado: true },
    { clave: "propina_camarista", valor: 75, confirmado: true },
    { clave: "propina_bellboy", valor: 85, confirmado: true },
    { clave: "saldo_dias_antes", valor: 15, confirmado: true },
  ],
  temporadas: [
    { nombre: "alta", desde_mes: 12, desde_dia: 1, hasta_mes: 12, hasta_dia: 31 },
    { nombre: "alta", desde_mes: 1, desde_dia: 1, hasta_mes: 4, hasta_dia: 30 },
    { nombre: "media", desde_mes: 10, desde_dia: 1, hasta_mes: 11, hasta_dia: 30 },
    { nombre: "media", desde_mes: 5, desde_dia: 1, hasta_mes: 5, hasta_dia: 31 },
    { nombre: "baja", desde_mes: 6, desde_dia: 1, hasta_mes: 9, hasta_dia: 30 },
  ],
  espacios: [
    { clave: "SALON-CENTRO", nombre: "Centro Avándaro", tipo: "Salón", ubicacion: "Casa Club", interior: true, cap_auditorio: 300, cap_banquete: 200, cap_coctel: 400, cap_escuela: 180, notas: "Divisible", activo: true },
    { clave: "SALON-JARDIN", nombre: "Salón Jardín", tipo: "Salón", ubicacion: "Jardín", interior: true, cap_auditorio: 150, cap_banquete: 120, cap_coctel: 200, cap_escuela: 90, notas: null, activo: true },
    { clave: "JARDIN-LAGO", nombre: "Jardín del Lago", tipo: "Jardín", ubicacion: "Lago", interior: false, cap_auditorio: null, cap_banquete: 180, cap_coctel: 250, cap_escuela: null, notas: null, activo: true },
    { clave: "TERRAZA-GOLF", nombre: "Terraza Campo de Golf", tipo: "Terraza", ubicacion: "Hoyo 18", interior: false, cap_auditorio: null, cap_banquete: 100, cap_coctel: 150, cap_escuela: null, notas: null, activo: true },
    { clave: "KIOSKO", nombre: "Kiosko", tipo: "Kiosko", ubicacion: "Jardín central", interior: false, cap_auditorio: null, cap_banquete: 40, cap_coctel: 60, cap_escuela: null, notas: null, activo: true },
    { clave: "SALA-CONSEJO", nombre: "Sala de Consejo", tipo: "Sala de juntas", ubicacion: "Planta alta", interior: true, cap_auditorio: null, cap_banquete: null, cap_coctel: null, cap_escuela: 20, notas: null, activo: true },
  ],
  tarifas_espacio: [
    ["SALON-CENTRO","alta","fin",78000,180000],["SALON-CENTRO","alta","semana",58000,120000],
    ["SALON-CENTRO","media","fin",62000,140000],["SALON-CENTRO","media","semana",44000,95000],
    ["SALON-CENTRO","baja","fin",48000,110000],["SALON-CENTRO","baja","semana",32000,70000],
    ["SALON-JARDIN","alta","fin",46000,110000],["SALON-JARDIN","alta","semana",34000,75000],
    ["SALON-JARDIN","media","fin",37000,88000],["SALON-JARDIN","media","semana",26000,58000],
    ["SALON-JARDIN","baja","fin",29000,68000],["SALON-JARDIN","baja","semana",19000,44000],
    ["JARDIN-LAGO","alta","fin",68000,150000],["JARDIN-LAGO","alta","semana",50000,105000],
    ["JARDIN-LAGO","media","fin",54000,120000],["JARDIN-LAGO","media","semana",39000,82000],
    ["JARDIN-LAGO","baja","fin",41000,90000],["JARDIN-LAGO","baja","semana",28000,60000],
    ["TERRAZA-GOLF","alta","fin",39000,90000],["TERRAZA-GOLF","alta","semana",29000,62000],
    ["TERRAZA-GOLF","media","fin",31000,72000],["TERRAZA-GOLF","media","semana",22000,48000],
    ["TERRAZA-GOLF","baja","fin",24000,56000],["TERRAZA-GOLF","baja","semana",16000,36000],
    ["KIOSKO","alta","fin",22000,40000],["KIOSKO","alta","semana",16000,28000],
    ["KIOSKO","media","fin",18000,32000],["KIOSKO","media","semana",12000,22000],
    ["KIOSKO","baja","fin",14000,26000],["KIOSKO","baja","semana",9000,17000],
    ["SALA-CONSEJO","alta","fin",14000,0],["SALA-CONSEJO","alta","semana",11000,0],
    ["SALA-CONSEJO","media","fin",11000,0],["SALA-CONSEJO","media","semana",9000,0],
    ["SALA-CONSEJO","baja","fin",9000,0],["SALA-CONSEJO","baja","semana",7000,0],
  ].map(([espacio, temporada, tipo_dia, tarifa_dia, consumo_minimo]) =>
    ({ espacio, temporada, tipo_dia, tarifa_dia, consumo_minimo })),
  paquetes_ayb: [
    { clave: "PAQ-COFFEE", nombre: "Coffee break", precio_persona: 480, incluye: "Café y pan", activo: true },
    { clave: "PAQ-EJECUTIVO", nombre: "Paquete ejecutivo", precio_persona: 1850, incluye: "Desayuno, coffee breaks y comida", activo: true },
    { clave: "PAQ-BANQUETE", nombre: "Banquete", precio_persona: 2400, incluye: "Cena de tres tiempos", activo: true },
    { clave: "PAQ-TODO", nombre: "Todo incluido", precio_persona: 3600, incluye: "Alimentos y barra libre", activo: true },
  ],
  tarifas_hospedaje: [
    ["HAB-INDIVIDUAL","Habitación individual","semana",3900,1,30],["HAB-INDIVIDUAL","Habitación individual","fin",4600,1,30],
    ["HAB-DOBLE","Habitación doble","semana",4190,2,44],["HAB-DOBLE","Habitación doble","fin",5600,2,44],
    ["HAB-SUITE","Suite Premium","semana",4244,2,6],["HAB-SUITE","Suite Premium","fin",5950,2,6],
    ["HAB-PRESIDENCIAL","Presidencial","semana",6840,2,1],["HAB-PRESIDENCIAL","Presidencial","fin",12250,2,1],
  ].map(([tipo_habitacion, nombre, tipo_dia, tarifa_noche, ocupacion_max, inventario]) =>
    ({ tipo_habitacion, nombre, tipo_dia, tarifa_noche, ocupacion_max, inventario })),
  // Las 17 actividades reales del cotizador del hotel, con su precio.
  // Se generan desde el mismo JSON que alimenta sql/tarifario_real.sql,
  // para que la prueba y la base no se separen.
  experiencias: [
    { clave: "ACT-CUATRIMOTO", nombre: "Cuatrimoto 2 horas", categoria: "Aventura y naturaleza", duracion_horas: 2, modo_cobro: "por_persona", precio_persona: 3200, cotizar_aparte: false, activo: true },
    { clave: "ACT-HIKING-BOSQUE", nombre: "Hiking en el bosque: cascadas, La Peña, miradores", categoria: "Aventura y naturaleza", duracion_horas: 3, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 25, monto: 1350 }, { desde: 26, hasta: 999, monto: 1280 }], maximo_personas: 999, nota: "El monto del último tramo parece ser por persona, pero su cotizador lo cobra plano. Confirmar con Avándaro.", cotizar_aparte: false, activo: true },
    { clave: "ACT-TOUR-RZR-2PAX", nombre: "Tour en RZR 2 PAX / 2 horas", categoria: "Aventura y naturaleza", duracion_horas: 2, modo_cobro: "por_persona", precio_persona: 4500, cotizar_aparte: false, activo: true },
    { clave: "ACT-TOUR-RZR-4PAX", nombre: "Tour en RZR 4 PAX / 2 horas", categoria: "Aventura y naturaleza", duracion_horas: 2, modo_cobro: "por_persona", precio_persona: 6150, cotizar_aparte: false, activo: true },
    { clave: "ACT-CENA-MARIDAJE", nombre: "Cena de maridaje estratégico", categoria: "Gastronomía y cultura", duracion_horas: 2.5, modo_cobro: "por_persona", precio_persona: 1200, cotizar_aparte: false, activo: true },
    { clave: "ACT-COCTELERIA", nombre: "Laboratorio de coctelería empresarial", categoria: "Gastronomía y cultura", duracion_horas: 2, modo_cobro: "por_persona", precio_persona: 850, cotizar_aparte: false, activo: true },
    { clave: "ACT-PIZZA-CIEGAS", nombre: "Pizza a ciegas", categoria: "Gastronomía y cultura", duracion_horas: 2.5, modo_cobro: "por_persona", precio_persona: 950, cotizar_aparte: false, activo: true },
    { clave: "ACT-COACHING-EJECUTIVO", nombre: "Liderazgo y diseño del futuro: coaching ejecutivo", categoria: "Estrategia y planeación", duracion_horas: 3, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 10, monto: 2780 }, { desde: 11, hasta: 19, monto: 2100 }, { desde: 20, hasta: 999, monto: 1900 }], maximo_personas: 999, nota: "El monto del último tramo parece ser por persona, pero su cotizador lo cobra plano. Confirmar con Avándaro.", cotizar_aparte: false, activo: true },
    { clave: "ACT-CIRCUITO-ENERGIA", nombre: "Circuito de energía", categoria: "Team building y liderazgo", duracion_horas: 3, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 10, monto: 19958.4 }, { desde: 11, hasta: 20, monto: 27466.66 }, { desde: 21, hasta: 30, monto: 41199.99 }, { desde: 31, hasta: 40, monto: 54933.33 }, { desde: 41, hasta: 50, monto: 68666.66 }, { desde: 51, hasta: 60, monto: 82399.99 }, { desde: 61, hasta: 70, monto: 82399.99 }], maximo_personas: 70, cotizar_aparte: false, activo: true },
    { clave: "ACT-MURO-ESCALAR", nombre: "Experiencia singular: muro de escalar", categoria: "Team building y liderazgo", duracion_horas: 2, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 10, monto: 15041.3 }, { desde: 11, hasta: 20, monto: 26187 }, { desde: 21, hasta: 30, monto: 40068.3 }, { desde: 31, hasta: 40, monto: 50054 }, { desde: 41, hasta: 50, monto: 63775.3 }, { desde: 51, hasta: 60, monto: 72645 }], maximo_personas: 60, cotizar_aparte: false, activo: true },
    { clave: "ACT-RALLY-TEAMBUILDING", nombre: "Rally team building: desafíos en equipo", categoria: "Team building y liderazgo", duracion_horas: 3, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 10, monto: 19958.4 }, { desde: 11, hasta: 20, monto: 27466.66 }, { desde: 21, hasta: 30, monto: 41199.99 }, { desde: 31, hasta: 40, monto: 54933.33 }, { desde: 41, hasta: 50, monto: 68666.66 }, { desde: 51, hasta: 60, monto: 82399.99 }], maximo_personas: 60, cotizar_aparte: false, activo: true },
    { clave: "ACT-REGATA-TEAMBUILDING", nombre: "Regata Team Building", categoria: "Team building y liderazgo", duracion_horas: 3, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 10, monto: 29667 }, { desde: 11, hasta: 20, monto: 38297.49 }, { desde: 21, hasta: 30, monto: 57553.98 }, { desde: 31, hasta: 40, monto: 72764.2 }, { desde: 41, hasta: 50, monto: 81674.2 }, { desde: 51, hasta: 60, monto: 98601.39 }], maximo_personas: 60, cotizar_aparte: false, activo: true },
    { clave: "ACT-RETOS-LIDERAZGO", nombre: "Retos de trabajo: liderazgo y trabajo en equipo", categoria: "Team building y liderazgo", duracion_horas: 3, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 10, monto: 19958.4 }, { desde: 11, hasta: 20, monto: 27466.66 }, { desde: 21, hasta: 30, monto: 41199.99 }, { desde: 31, hasta: 40, monto: 54933.33 }, { desde: 41, hasta: 50, monto: 68666.66 }, { desde: 51, hasta: 60, monto: 82399.99 }], maximo_personas: 60, cotizar_aparte: false, activo: true },
    { clave: "ACT-CHI-KUNG", nombre: "Chi Kung / Meditación en movimiento", categoria: "Bienestar y relajación", duracion_horas: 1.5, modo_cobro: "por_tramo", tramos: [{ desde: 1, hasta: 25, monto: 1495 }, { desde: 26, hasta: 999, monto: 1350 }], maximo_personas: 999, nota: "El monto del último tramo parece ser por persona, pero su cotizador lo cobra plano. Confirmar con Avándaro.", cotizar_aparte: false, activo: true },
    { clave: "ACT-WIM-HOF", nombre: "Método Wim Hof", categoria: "Bienestar y relajación", duracion_horas: 2, modo_cobro: "por_persona", precio_persona: 1900, cotizar_aparte: false, activo: true },
    { clave: "ACT-RITUAL-CHAMANICO", nombre: "Ritual Chamánico Mexica", categoria: "Bienestar y relajación", duracion_horas: 2, modo_cobro: "por_persona", precio_persona: 1200, cotizar_aparte: false, activo: true },
    { clave: "ACT-SHIN-RIN-YOKU", nombre: "Shin Rin Yoku / Baño de bosque / Caminata Velo de Novia", categoria: "Bienestar y relajación", duracion_horas: 2, modo_cobro: "por_persona", precio_persona: 850, cotizar_aparte: false, activo: true },
  ],
  reglas_descuento: [
    { clave: "HAB-30", descripcion: "Descuento por bloque de 30 habitaciones o más", aplica_a: "hospedaje", campo: "habitaciones", operador: ">=", valor: 30, porcentaje: 0.10, temporada: null, activo: true },
    { clave: "HAB-50", descripcion: "Descuento por bloque de 50 habitaciones o más", aplica_a: "hospedaje", campo: "habitaciones", operador: ">=", valor: 50, porcentaje: 0.15, temporada: null, activo: true },
    { clave: "HAB-100", descripcion: "Descuento por bloque de 100 habitaciones o más", aplica_a: "hospedaje", campo: "habitaciones", operador: ">=", valor: 100, porcentaje: 0.22, temporada: null, activo: true },
    { clave: "SALON-CORTESIA", descripcion: "Cortesía de salón con 120 personas o más", aplica_a: "espacio", campo: "personas", operador: ">=", valor: 120, porcentaje: 1.00, temporada: null, activo: true },
    { clave: "SALON-3D", descripcion: "Descuento por evento de 3 días o más", aplica_a: "espacio", campo: "dias", operador: ">=", valor: 3, porcentaje: 0.15, temporada: null, activo: true },
    { clave: "AYB-150", descripcion: "Descuento en alimentos con 150 personas o más", aplica_a: "ayb", campo: "personas", operador: ">=", valor: 150, porcentaje: 0.08, temporada: null, activo: true },
    { clave: "BAJA-SALON", descripcion: "Promoción de temporada baja en renta de espacio", aplica_a: "espacio", campo: "personas", operador: ">=", valor: 1, porcentaje: 0.20, temporada: "baja", activo: true },
  ],
};

const bitacora = [];
const conversaciones = new Map();   // el hilo de WhatsApp, que sí se relee

// --- PostgREST falso -------------------------------------------------
const fake = http.createServer((req, res) => {
  const tabla = req.url.split("?")[0].replace("/rest/v1/", "");

  if (req.method === "POST") {
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => {
      const fila = JSON.parse(cuerpo);
      if (tabla === "conversaciones") conversaciones.set(fila.wa_id, fila);
      else bitacora.push(fila);
      res.writeHead(201).end();
    });
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  if (tabla === "conversaciones") {
    const m = /wa_id=eq\.([^&]+)/.exec(req.url);
    const fila = m ? conversaciones.get(decodeURIComponent(m[1])) : null;
    return res.end(JSON.stringify(fila ? [fila] : []));
  }
  res.end(JSON.stringify(DATOS[tabla] ?? []));
});

const PUERTO_FAKE = 54321;
const PUERTO_APP = 54322;
const TOKEN = "token-de-prueba";

const pesos = (n) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

async function main() {
  await new Promise((r) => fake.listen(PUERTO_FAKE, r));

  const app = spawn("node", ["server.js"], {
    env: { ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${PUERTO_FAKE}`,
      SUPABASE_SERVICE_KEY: "fake",
      COTIZADOR_TOKEN: TOKEN,
      WHATSAPP_TOKEN: TOKEN,
      PORT: String(PUERTO_APP) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => app.stdout.once("data", r));

  const pedir = async (cuerpo) => {
    const r = await fetch(`http://127.0.0.1:${PUERTO_APP}/cotizar/${TOKEN}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    return r.json();
  };

  const ESCENARIOS = [
    ["Convención corporativa, 80 personas, 2 días, 30 habitaciones, marzo (temporada alta, entre semana)",
     { fecha_inicio: "2027-03-16", personas: 80, dias: 2, habitaciones: 30, noches: 2,
       espacio: "SALON-CENTRO", paquete_ayb: "PAQ-EJECUTIVO", tipo_habitacion: "HAB-DOBLE" }],

    ["Boda de 150 personas en sábado de temporada alta, sin espacio indicado",
     { fecha_inicio: "2027-02-13", personas: 150, dias: 1, paquete_ayb: "PAQ-BANQUETE", montaje: "banquete" }],

    ["Evento de 3 días en temporada baja, entre semana (dos descuentos compiten en espacio)",
     { fecha_inicio: "2027-07-13", personas: 60, dias: 3, espacio: "SALON-JARDIN", paquete_ayb: "PAQ-EJECUTIVO" }],

    ["Junta de consejo de 15 personas",
     { fecha_inicio: "2027-10-20", personas: 15, dias: 1, espacio: "SALA-CONSEJO", paquete_ayb: "PAQ-COFFEE" }],

    ["Bloque grande: 200 personas, 60 habitaciones, 2 noches",
     { fecha_inicio: "2027-11-19", personas: 200, dias: 2, habitaciones: 60, noches: 2,
       espacio: "SALON-CENTRO", paquete_ayb: "PAQ-TODO", tipo_habitacion: "HAB-SUITE" }],

    ["No cabe: 500 personas en el Kiosko",
     { fecha_inicio: "2027-03-16", personas: 500, dias: 1, espacio: "KIOSKO" }],

    ["Consumo por debajo del mínimo del espacio",
     { fecha_inicio: "2027-02-13", personas: 40, dias: 1, espacio: "SALON-CENTRO", paquete_ayb: "PAQ-COFFEE" }],

    ["Grupo chico, el mismo caso que arma el cotizador público del hotel: 5 personas, 4 individuales, 2 noches",
     { fecha_inicio: "2027-03-16", personas: 5, dias: 2, habitaciones: 4, noches: 2,
       tipo_habitacion: "HAB-INDIVIDUAL", espacio: "SALA-CONSEJO", paquete_ayb: "PAQ-COFFEE" }],

    ["Con actividades: ya las cobra, con el precio por tramo del hotel",
     { fecha_inicio: "2027-03-16", personas: 20, dias: 1, espacio: "SALON-JARDIN",
       paquete_ayb: "PAQ-COFFEE", experiencias: ["regata", "muro de escalar", "paseo en globo"] }],

    // Dos formas de cobro en la misma cotización, y un grupo que se sale
    // del aforo de una de ellas. El circuito de energía llega a 70
    // personas; la cuatrimoto se cobra por cabeza sin tope.
    ["Actividades: por tramo, por persona, y una que no cabe",
     { fecha_inicio: "2027-03-16", personas: 80, dias: 1, espacio: "SALON-CENTRO",
       experiencias: ["cuatrimoto", "circuito de energía", "ritual chamánico"] }],

    ["Faltan datos obligatorios",
     { fecha_inicio: "2027-03-16" }],
  ];

  for (const [titulo, cuerpo] of ESCENARIOS) {
    const d = await pedir(cuerpo);
    console.log("\n" + "=".repeat(78));
    console.log(titulo);
    console.log("=".repeat(78));
    if (!d.ok) { console.log("  RECHAZADA:", (d.errores || []).join(" · ")); continue; }

    console.log(`  ${d.espacio.nombre}  ·  temporada ${d.temporada}  ·  día de ${d.tipo_dia}`);
    for (const l of d.desglose) console.log(`    ${l.concepto.padEnd(22)} ${pesos(l.importe).padStart(16)}   ${l.detalle}`);
    for (const x of d.descuentos) console.log(`    ${("− " + x.regla).padEnd(22)} ${("-" + pesos(x.importe)).padStart(16)}   ${x.descripcion}`);
    console.log(`    ${"Subtotal".padEnd(22)} ${pesos(d.importes.subtotal).padStart(16)}`);
    console.log(`    ${"IVA + ISH".padEnd(22)} ${pesos(d.importes.iva + d.importes.ish).padStart(16)}`);
    for (const e of d.experiencias || [])
      console.log(`    ${("+ " + e.nombre).padEnd(22)} ${pesos(e.importe).padStart(16)}   ${e.duracion}`);
    if (d.importes.propinas) console.log(`    ${"Propinas".padEnd(22)} ${pesos(d.importes.propinas).padStart(16)}   camaristas y bellboys, sin impuestos`);
    console.log(`    ${"TOTAL".padEnd(22)} ${pesos(d.importes.total).padStart(16)}`);
    const relevantes = d.avisos.filter((a) => !a.startsWith("TARIFARIO") && !a.startsWith("Disponibilidad") && !a.startsWith("Parámetros"));
    for (const a of relevantes) console.log(`    aviso: ${a}`);
  }

  // -------------------------------------------------------------------
  // Camino de voz (Aircall)
  //
  // Se prueba igual que lo va a llamar el agente: secreto en la
  // cabecera, parámetros como texto, y la fecha dicha en español.
  // -------------------------------------------------------------------
  console.log("\n" + "=".repeat(78));
  console.log("CAMINO DE VOZ · como lo llama el AI Voice Agent de Aircall");
  console.log("=".repeat(78));

  const voz = async (cuerpo, cabeceras = {}) => {
    const r = await fetch(`http://127.0.0.1:${PUERTO_APP}/voz/cotizar`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 Authorization: `Bearer ${TOKEN}`, ...cabeceras },
      body: JSON.stringify(cuerpo),
    });
    return { estado: r.status, cuerpo: await r.json() };
  };

  const ping = await fetch(`http://127.0.0.1:${PUERTO_APP}/voz/ping`,
    { headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log(`\n  Test Connection  →  HTTP ${ping.status}  ${JSON.stringify(await ping.json())}`);

  const malo = await voz({ personas: "80" }, { Authorization: "Bearer equivocado" });
  console.log(`  Token equivocado →  HTTP ${malo.estado}  (debe ser 401)`);

  const hablado = await voz({
    fecha_inicio: "16 de marzo de 2027",
    personas: "80", dias: "2", habitaciones: "30", noches: "2",
    espacio: "SALON-CENTRO", paquete_ayb: "PAQ-EJECUTIVO", tipo_habitacion: "HAB-DOBLE",
  });
  console.log(`\n  Cotización por voz →  HTTP ${hablado.estado}`);
  for (const [k, v] of Object.entries(hablado.cuerpo)) {
    if (k === "folio_deletreado") continue;
    console.log(`    ${k.padEnd(12)} ${v}`);
  }

  // Lo que de verdad llega por teléfono: nadie dice "SALON-CENTRO" ni
  // "PAQ-EJECUTIVO" hablando.
  const HABLADAS = [
    ["en palabras", { espacio: "Centro Avándaro", paquete_ayb: "paquete ejecutivo",
                      tipo_habitacion: "doble" }],
    ["a medias",    { paquete_ayb: "ejecutivo" }],
    ["sin comida",  { espacio: "Centro Avándaro", paquete_ayb: "sin alimentos" }],
    ["inventado",   { espacio: "Centro Avándaro", paquete_ayb: "paquete vegano premium" }],
  ];
  for (const [etiqueta, extra] of HABLADAS) {
    const r = await voz({ fecha_inicio: "16 de marzo de 2027", personas: "80",
                          dias: "2", habitaciones: "30", noches: "2", ...extra });
    console.log(`\n  Catálogo ${etiqueta} →  ok=${r.cuerpo.ok}  ${r.cuerpo.espacio ?? ""}`);
    console.log(`    ${r.cuerpo.total || r.cuerpo.error}`);
    if (r.cuerpo.nota) console.log(`    nota: ${r.cuerpo.nota}`);
  }

  const incompleto = await voz({ fecha_inicio: "16 de marzo de 2027" });
  console.log(`\n  Sin número de personas →  HTTP ${incompleto.estado} (debe ser 200 para que el agente lo pueda decir)`);
  console.log(`    ok     ${incompleto.cuerpo.ok}`);
  console.log(`    error  ${incompleto.cuerpo.error}`);

  // -------------------------------------------------------------------
  // Camino de WhatsApp
  //
  // Aquí lo que se prueba es la CONVERSACIÓN, no el motor: que recuerde
  // lo dicho, que entienda un número suelto solo cuando viene
  // contestando algo, y que no cotice antes de tener lo mínimo.
  // -------------------------------------------------------------------
  console.log("\n" + "=".repeat(78));
  console.log("CAMINO DE WHATSAPP · conversación completa");
  console.log("=".repeat(78));

  const wa = async (texto, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${PUERTO_APP}/whatsapp/simular/${TOKEN}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ de: "5215512345678", texto, ...extra }),
    });
    return r.json();
  };

  const GUION = [
    ["Hola, buenas tardes", { reiniciar: true }],
    ["Sería el 16 de marzo"],
    ["somos 80"],                                  // número suelto: solo cuenta porque se preguntó
    ["dos días, en el Centro Avándaro"],           // dos datos en un mensaje
    ["el paquete ejecutivo"],                      // catálogo por alias
    ["sí, 30 habitaciones por 2 noches"],
  ];

  let ultimo = null;
  for (const [texto, extra] of GUION) {
    const r = await wa(texto, extra || {});
    ultimo = r;
    console.log(`\n  ►  ${texto}`);
    for (const m of r.mensajes) {
      console.log("     " + m.split("\n").join("\n     "));
    }
  }

  // 742,322 con el modelo de impuestos del hotel. Antes eran 807,986,
  // cuando el IVA se aplicaba también a la renta de espacio y la renta
  // salía de una tarifa por salón que nos habíamos inventado.
  //
  //   espacio       4 bloques x 9,500 x 2 días      76,000.00
  //   alimentos     296,000 x 1.31                 387,760.00
  //   hospedaje     226,260 x 1.20                 271,512.00
  //   propinas      30 hab                           7,050.00
  const esperado = 742322;
  const bit = bitacora.filter((b) => b.origen === "whatsapp").pop();
  console.log(`\n  Resultado: folio ${ultimo.folio || "(ninguno)"} · ` +
    `total ${bit ? bit.total : "—"} · esperado ${esperado} · ` +
    (bit && bit.total === esperado ? "COINCIDE con los otros canales" : "NO COINCIDE"));
  console.log(`  Memoria del hilo: ${JSON.stringify(ultimo.datos)}`);

  // Rechazo, empezando de cero
  console.log("\n  --- hilo nuevo, caso que no cabe ---");
  for (const [t, e] of [["otra cotización", {}], ["500 personas en el kiosko el 16 de marzo", {}]]) {
    const r = await wa(t, e);
    console.log(`\n  ►  ${t}`);
    for (const m of r.mensajes) console.log("     " + m);
  }

  // -------------------------------------------------------------------
  // Volcado para el demo
  //
  // VOLCADO=ruta.json node prueba.js
  //
  // Escribe las respuestas REALES del motor, por los dos caminos, para
  // que el demo que se le enseña al cliente no sean capturas dibujadas
  // a mano sino lo que el sistema de verdad contesta.
  // -------------------------------------------------------------------
  if (process.env.VOLCADO) {
    const { writeFile } = await import("node:fs/promises");
    const captura = [];
    for (const [titulo, cuerpo] of ESCENARIOS) {
      captura.push({
        titulo,
        peticion: cuerpo,
        completa: await pedir(cuerpo),
        voz: (await voz(cuerpo)).cuerpo,
      });
    }
    await writeFile(process.env.VOLCADO, JSON.stringify(captura, null, 2));
    console.log(`\nVolcado: ${captura.length} escenarios en ${process.env.VOLCADO}`);
  }

  console.log("\n" + "=".repeat(78));
  console.log(`Bitácora: ${bitacora.length} cotizaciones registradas ` +
              `(${bitacora.filter((b) => !b.error).length} exitosas, ${bitacora.filter((b) => b.error).length} con error)`);
  console.log(`  por origen: ` + Object.entries(
    bitacora.reduce((a, b) => ({ ...a, [b.origen]: (a[b.origen] || 0) + 1 }), {}))
    .map(([k, v]) => `${k}=${v}`).join(", "));

  app.kill();
  fake.close();
}

main().catch((e) => { console.error(e); process.exit(1); });