// =====================================================================
// Pruebas de los caminos de falla del cerebro.
//
// POR QUÉ EXISTE ESTE ARCHIVO
//
// El 29 de octubre de 2026, en vivo, llegó este mensaje:
//
//   "Quiero cotizar un evento para 80 personas el 16 de marzo, dos
//    días, con desayuno buffet y comida buffet, 30 habitaciones por
//    dos noches, y queremos el circuito de energía"
//
// Traía absolutamente todo lo necesario para cotizar. El cliente
// recibió: "Disculpe, no entendí. ¿Me repite qué necesita?"
//
// La causa: Gemini contestó 200 pero con un candidato sin partes, ni
// texto ni llamadas a herramientas. Eso no lanza excepción, así que el
// despachador nunca se enteró y la capa de reglas, que tenía todo para
// contestar, no entró. Veinticuatro minutos después un simple "Hola"
// hizo que el modelo viera ese mensaje en el historial y emitiera la
// cotización completa, lo cual se ve peor todavía.
//
// Ninguna prueba cubría ese camino porque no había forma de hacer que
// Gemini fallara a voluntad. Ahora sí: cerebro.js lee la raíz de la API
// de GEMINI_RAIZ, y aquí se levanta un servidor que finge cada falla.
//
// Correr con:  node prueba-respaldo.js
// =====================================================================

import http from "node:http";

const PUERTO = 54399;

// Catálogo mínimo: lo que se prueba es el despacho, no el tarifario.
const CAT = {
  parametros: { iva: 0.16, ish: 0.04, servicio: 0.15,
                salon_bloque_personas: 25, salon_bloque_precio: 9500,
                vigencia_dias: 15, anticipo_pct: 0.5,
                propina_camarista: 75, propina_bellboy: 85 },
  espacios: [{ clave: "SALON-CENTRO", nombre: "Centro Avándaro", tipo: "Salón",
               interior: true, cap_auditorio: 300, cap_banquete: 200,
               cap_coctel: 400, cap_escuela: 180, activo: true }],
  alimentos: [{ clave: "AYB-DESAYUNO_BUFFET", nombre: "Desayuno buffet",
                precio_persona: 580, por_hora: false, activo: true }],
  hospedaje: [], experiencias: [], temporadas: [], tarifas: [],
  paquetes: [], reglas: [], salones: [], sinConfirmar: [],
};

// Las respuestas que puede dar el servidor falso.
const RESPUESTAS = {
  // 200 con un candidato sin partes. El caso que nos falló en vivo.
  vacio: () => [200, { candidates: [{ content: { role: "model", parts: [] },
                                      finishReason: "STOP" }] }],
  // Sin candidatos: otra forma del mismo problema.
  sinCandidatos: () => [200, { candidates: [] }],
  // Cuota agotada.
  cuota: () => [429, { error: { code: 429, message: "Resource exhausted" } }],
  // Modelo saturado.
  saturado: () => [503, { error: { code: 503, message: "Service unavailable" } }],
};

let modo = "vacio";
let llamadas = 0;

const falso = http.createServer((q, r) => {
  llamadas++;
  const [codigo, cuerpo] = RESPUESTAS[modo]();
  r.writeHead(codigo, { "content-type": "application/json" });
  r.end(JSON.stringify(cuerpo));
});

let fallas = 0;
const revisa = (ok, texto) => {
  if (!ok) fallas++;
  console.log(`    ${ok ? "ok   " : "FALLA"}  ${texto}`);
};

async function main() {
  await new Promise((ok) => falso.listen(PUERTO, ok));

  process.env.GEMINI_API_KEY = "falsa";
  process.env.GEMINI_RAIZ = `http://127.0.0.1:${PUERTO}`;
  // Ojo: la cadena vacía es falsy, así que cerebro.js cae a su lista de
  // respaldos por default y los cuatro modelos acaban pegándole a este
  // mismo servidor falso. Se deja así a propósito: recorre la cadena
  // completa de reintentos, que es mejor cobertura. El costo es que los
  // casos de 429 y 503 tardan unos segundos cada uno.
  process.env.GEMINI_MODELOS_RESPALDO = "";

  const wa = await import("./whatsapp.js");

  const deps = {
    cliente: null, kb: null,
    catalogos: async () => CAT,
    cotizar: async () => ({ ok: false, errores: ["motor simulado"] }),
  };

  const MENSAJE_COMPLETO =
    "80 personas el 16 de marzo, dos días, desayuno buffet, " +
    "30 habitaciones por dos noches";

  // -------------------------------------------------------------------
  // Hilo nuevo y el modelo no sirve: deben contestar las reglas.
  // -------------------------------------------------------------------
  for (const caso of ["vacio", "sinCandidatos", "cuota", "saturado"]) {
    modo = caso;
    llamadas = 0;
    console.log(`\n  hilo nuevo · el modelo responde "${caso}"`);

    const r = await wa.responder(
      { wa_id: `52155000000${caso.length}`, texto: MENSAJE_COMPLETO, nombre: "David" },
      deps);

    console.log(`    respuesta: "${(r.mensajes[0] || "").slice(0, 64)}"`);
    revisa(!/no entend/i.test(r.mensajes[0] || ""),
           "no contesta 'no entendí'");
    revisa(!/se me trab/i.test(r.mensajes[0] || ""),
           "no contesta 'se me trabó' en un hilo nuevo");
    revisa((r.mensajes[0] || "").length > 0, "contesta algo");
    revisa((r.estado?.historial?.length ?? 0) === 0,
           "historial limpio: el modelo no re-actuará sobre este mensaje");
  }

  // -------------------------------------------------------------------
  // Hilo ya abierto y el modelo falla: aquí SÍ se pide repetir.
  //
  // Las reglas tienen su propia memoria y a media conversación
  // contestarían ignorando lo ya dicho. Dos motores alternándose se
  // sienten peor que uno fallando con honestidad.
  // -------------------------------------------------------------------
  console.log("\n  hilo ya abierto · el modelo falla");
  const wa_id = "5215511111111";
  const st = { wa_id, datos: { personas: 80 },
               historial: [{ role: "user", parts: [{ text: "hola" }] },
                           { role: "model", parts: [{ text: "¿Para qué fecha?" }] }],
               esperando: null, preguntado: [], actualizado: Date.now() };
  wa.ESTADOS.set(wa_id, st);

  modo = "cuota";
  const r2 = await wa.responder({ wa_id, texto: MENSAJE_COMPLETO, nombre: "David" }, deps);
  console.log(`    respuesta: "${(r2.mensajes[0] || "").slice(0, 64)}"`);
  revisa(/se me trab/i.test(r2.mensajes[0] || ""),
         "pide repetir en lugar de cambiar de motor");
  revisa((r2.estado?.historial?.length ?? 0) > 0,
         "historial intacto: la siguiente vuelta sigue donde iba");

  falso.close();
  console.log("\n" + "=".repeat(70));
  console.log(fallas ? `${fallas} FALLAS` : "todo pasa");
  process.exit(fallas ? 1 : 0);
}

main();