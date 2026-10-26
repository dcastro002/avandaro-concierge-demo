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
    { clave: "iva", valor: 0.16, confirmado: false },
    { clave: "ish", valor: 0.03, confirmado: false },
    { clave: "servicio", valor: 0.15, confirmado: false },
    { clave: "vigencia_dias", valor: 15, confirmado: false },
    { clave: "anticipo_pct", valor: 0.5, confirmado: false },
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
    ["HAB-ESTANDAR","Habitación estándar","alta",5400,2],["HAB-ESTANDAR","Habitación estándar","media",4300,2],["HAB-ESTANDAR","Habitación estándar","baja",3400,2],
    ["HAB-JUNIOR","Junior suite","alta",7900,3],["HAB-JUNIOR","Junior suite","media",6300,3],["HAB-JUNIOR","Junior suite","baja",4900,3],
    ["HAB-SUITE","Suite","alta",11500,4],["HAB-SUITE","Suite","media",9200,4],["HAB-SUITE","Suite","baja",7200,4],
  ].map(([tipo_habitacion, nombre, temporada, tarifa_noche, ocupacion_max]) =>
    ({ tipo_habitacion, nombre, temporada, tarifa_noche, ocupacion_max })),
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

// --- PostgREST falso -------------------------------------------------
const fake = http.createServer((req, res) => {
  const tabla = req.url.split("?")[0].replace("/rest/v1/", "");
  if (req.method === "POST") {
    let cuerpo = "";
    req.on("data", (c) => (cuerpo += c));
    req.on("end", () => { bitacora.push(JSON.parse(cuerpo)); res.writeHead(201).end(); });
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
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
       espacio: "SALON-CENTRO", paquete_ayb: "PAQ-EJECUTIVO", tipo_habitacion: "HAB-ESTANDAR" }],

    ["Boda de 150 personas en sábado de temporada alta, sin espacio indicado",
     { fecha_inicio: "2027-02-13", personas: 150, dias: 1, paquete_ayb: "PAQ-BANQUETE", montaje: "banquete" }],

    ["Evento de 3 días en temporada baja, entre semana (dos descuentos compiten en espacio)",
     { fecha_inicio: "2027-07-13", personas: 60, dias: 3, espacio: "SALON-JARDIN", paquete_ayb: "PAQ-EJECUTIVO" }],

    ["Junta de consejo de 15 personas",
     { fecha_inicio: "2027-10-20", personas: 15, dias: 1, espacio: "SALA-CONSEJO", paquete_ayb: "PAQ-COFFEE" }],

    ["Bloque grande: 200 personas, 60 habitaciones, 2 noches",
     { fecha_inicio: "2027-11-19", personas: 200, dias: 2, habitaciones: 60, noches: 2,
       espacio: "SALON-CENTRO", paquete_ayb: "PAQ-TODO", tipo_habitacion: "HAB-JUNIOR" }],

    ["No cabe: 500 personas en el Kiosko",
     { fecha_inicio: "2027-03-16", personas: 500, dias: 1, espacio: "KIOSKO" }],

    ["Consumo por debajo del mínimo del espacio",
     { fecha_inicio: "2027-02-13", personas: 40, dias: 1, espacio: "SALON-CENTRO", paquete_ayb: "PAQ-COFFEE" }],

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
    console.log(`    ${"TOTAL".padEnd(22)} ${pesos(d.importes.total).padStart(16)}`);
    const relevantes = d.avisos.filter((a) => !a.startsWith("TARIFARIO") && !a.startsWith("Disponibilidad") && !a.startsWith("Parámetros"));
    for (const a of relevantes) console.log(`    aviso: ${a}`);
  }

  console.log("\n" + "=".repeat(78));
  console.log(`Bitácora: ${bitacora.length} cotizaciones registradas ` +
              `(${bitacora.filter((b) => !b.error).length} exitosas, ${bitacora.filter((b) => b.error).length} con error)`);

  app.kill();
  fake.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
