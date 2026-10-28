// =====================================================================
// Cerebro conversacional · Gemini con herramientas
// Grupo Avándaro × Freelan
//
// QUÉ HACE Y QUÉ NO
//
// El modelo conversa: entiende "somos como 80 o 90, depende de
// confirmaciones", recuerda el hilo, pregunta lo que falta y contesta
// dudas del hotel con la base de conocimiento.
//
// EL MODELO NUNCA DICE UN PRECIO.
//
// Esto no es una recomendación, está hecho a propósito en el diseño: la
// herramienta de cotizar le devuelve al modelo un acuse SIN cifras, y el
// mensaje con los números lo manda nuestro código tal cual lo calculó el
// motor. El modelo no puede redondear "ochocientos ochenta mil, más o
// menos" porque nunca ve la cantidad.
//
// Frente a un cliente, con un tarifario de prueba, esa diferencia es
// todo el riesgo del proyecto.
//
// SIN LLAVE, NO PASA NADA
//
// Si no hay GEMINI_API_KEY, whatsapp.js sigue con su capa de reglas, que
// está probada. Esto es una mejora, no una dependencia.
// =====================================================================

const RAIZ = "https://generativelanguage.googleapis.com/v1beta";

export const MODELO_POR_DEFECTO = process.env.GEMINI_MODELO || "gemini-2.0-flash";

export function disponible() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// Recorta el historial sin partirlo a la mitad.
//
// Un turno del modelo que pide una herramienta y la respuesta de esa
// herramienta son un par: si el corte cae entre los dos, Gemini recibe
// una respuesta de función que no corresponde a ninguna llamada y
// contesta 400. Por eso se recorta y luego se avanza hasta el primer
// mensaje de la persona.
export function recortar(contents = [], maximo = 16) {
  const trozo = contents.slice(-maximo);
  const esTurnoDePersona = (c) =>
    c?.role === "user" && (c.parts || []).some((p) => typeof p.text === "string");
  let i = 0;
  while (i < trozo.length && !esTurnoDePersona(trozo[i])) i++;
  return i < trozo.length ? trozo.slice(i) : [];
}

// Los nombres de modelo de Google cambian seguido. En vez de adivinar,
// se pregunta. Sirve para el diagnóstico cuando algo da 404.
export async function listarModelos(llave = process.env.GEMINI_API_KEY) {
  const r = await fetch(`${RAIZ}/models?key=${encodeURIComponent(llave)}`);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => String(m.name).replace(/^models\//, ""));
}

// Sin tiempo límite, una llamada que no vuelve deja la conversación
// colgada para siempre y el respaldo de reglas nunca entra, porque nada
// lanza error. Mejor fallar rápido y contestar con reglas.
const LIMITE_MS = Number(process.env.GEMINI_TIMEOUT_MS || 18000);

// Modelos de respaldo. Una saturación momentánea de Google no debería
// tumbar la conversación: se reintenta con otro modelo antes de rendirse.
export const RESPALDOS = (process.env.GEMINI_MODELOS_RESPALDO || "gemini-3.1-flash-lite")
  .split(",").map((s) => s.trim()).filter(Boolean);

const TRANSITORIO = new Set([429, 500, 502, 503, 504]);

async function generarConRespaldo(cuerpo, modelos, llave) {
  let ultimo;
  for (let i = 0; i < modelos.length; i++) {
    try {
      return await generar(cuerpo, modelos[i], llave);
    } catch (e) {
      ultimo = e;
      const vale = TRANSITORIO.has(e.estado) || /no contestó en/.test(e.message);
      if (!vale || i === modelos.length - 1) throw e;
      console.log(`${modelos[i]} falló (${e.estado ?? "tiempo"}); se reintenta con ${modelos[i + 1]}.`);
    }
  }
  throw ultimo;
}

async function generar(cuerpo, modelo, llave) {
  let r;
  try {
    r = await fetch(
      `${RAIZ}/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(llave)}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(LIMITE_MS) });
  } catch (e) {
    const porTiempo = e.name === "TimeoutError" || e.name === "AbortError";
    throw new Error(porTiempo
      ? `Gemini no contestó en ${LIMITE_MS / 1000} s`
      : `No se pudo llamar a Gemini: ${e.message}`);
  }
  const texto = await r.text();
  if (!r.ok) {
    const e = new Error(`Gemini ${r.status}: ${texto.slice(0, 400)}`);
    e.estado = r.status;
    e.cuerpo = texto;
    throw e;
  }
  return JSON.parse(texto);
}

// El rol con el que se devuelve el resultado de una herramienta cambió
// entre versiones de la API: unas esperan "user", otras "function". En
// vez de apostar, se intenta uno y si la API se queja del rol, el otro.
let ROL_HERRAMIENTA = "user";

function partes(respuesta) {
  return respuesta?.candidates?.[0]?.content?.parts ?? [];
}

// ---------------------------------------------------------------------
// Sonda
//
// Prueba un modelo con lo mínimo y va agregando piezas, para aislar qué
// es lo que se atora: el modelo, las instrucciones de sistema o las
// herramientas. Cada combinación se prueba desde curl, sin desplegar.
// ---------------------------------------------------------------------
export async function probar({ modelo, sistema = false, herramientas = null,
                               llave = process.env.GEMINI_API_KEY, limite = 12000 } = {}) {
  const cuerpo = { contents: [{ role: "user", parts: [{ text: "Contesta solo: hola" }] }] };
  if (sistema) cuerpo.systemInstruction = { parts: [{ text: "Eres conciso." }] };
  if (herramientas?.length) cuerpo.tools = [{ functionDeclarations: herramientas }];

  const arranque = Date.now();
  try {
    const r = await fetch(
      `${RAIZ}/models/${encodeURIComponent(modelo)}:generateContent?key=${encodeURIComponent(llave)}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(limite) });
    const texto = await r.text();
    const ms = Date.now() - arranque;
    if (!r.ok) return { modelo, ok: false, ms, estado: r.status, error: texto.slice(0, 220) };
    const d = JSON.parse(texto);
    const dijo = (d?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text).filter(Boolean).join(" ").trim();
    return { modelo, ok: true, ms, dijo: dijo || "(sin texto)" };
  } catch (e) {
    const ms = Date.now() - arranque;
    const porTiempo = e.name === "TimeoutError" || e.name === "AbortError";
    return { modelo, ok: false, ms, error: porTiempo ? `colgado, cortado a los ${ms} ms` : e.message };
  }
}

/**
 * Conversa una vuelta.
 *
 * historial    historial previo en formato de contents de Gemini
 * sistema      instrucciones permanentes
 * herramientas declaraciones de función
 * ejecutar     async (nombre, args) => ({ resultado, mensajesDirectos? })
 *              resultado        es lo que VE el modelo
 *              mensajesDirectos son textos que mandamos tal cual, sin
 *                               que el modelo los toque
 */
export async function conversar({
  historial = [],
  mensaje,
  sistema,
  herramientas = [],
  ejecutar,
  emitir,
  modelo = MODELO_POR_DEFECTO,
  llave = process.env.GEMINI_API_KEY,
  maxVueltas = 3,
} = {}) {
  const contents = [...historial, { role: "user", parts: [{ text: mensaje }] }];
  const mensajes = [];
  const directos = [];
  const usadas = [];

  // Presupuesto total de la vuelta. Quien escribe por WhatsApp no
  // espera cuarenta segundos; prefiere una respuesta de reglas.
  const hastaCuando = Date.now() + LIMITE_MS * 2;

  for (let vuelta = 0; vuelta < maxVueltas; vuelta++) {
    if (Date.now() > hastaCuando) {
      console.log("Se agotó el presupuesto de tiempo del cerebro.");
      break;
    }
    const cuerpo = {
      contents,
      systemInstruction: { parts: [{ text: sistema }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
    };
    if (herramientas.length) cuerpo.tools = [{ functionDeclarations: herramientas }];

    const respuesta = await generarConRespaldo(
      cuerpo, [modelo, ...RESPALDOS.filter((m) => m !== modelo)], llave);
    const ps = partes(respuesta);

    const llamadas = ps.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textos = ps.filter((p) => p.text).map((p) => p.text.trim()).filter(Boolean);

    // El turno del modelo se devuelve TAL CUAL vino.
    //
    // Gemini 3 exige que las partes con functionCall conserven su
    // thought_signature cuando se le regresa el historial. Si uno las
    // reconstruye, aunque sea con los mismos datos visibles, esa firma
    // se pierde y la siguiente vuelta falla con un 400.
    const contenido = respuesta?.candidates?.[0]?.content;

    if (!llamadas.length) {
      if (textos.length) mensajes.push(...textos);
      if (contenido) contents.push(contenido);
      break;
    }

    contents.push(contenido ?? { role: "model", parts: ps.filter((p) => p.functionCall) });

    const respuestasHerramienta = [];
    for (const c of llamadas) {
      usadas.push(c.name);
      let resultado;
      try {
        const salida = await ejecutar(c.name, c.args || {});
        resultado = salida?.resultado ?? salida ?? {};
        if (salida?.mensajesDirectos?.length) {
          directos.push(...salida.mensajesDirectos);
          // La cotización sale AHORA, no cuando el modelo termine de
          // redactar su comentario. Son dos segundos de diferencia en
          // el único mensaje que de verdad le importa a quien espera.
          if (emitir) for (const m of salida.mensajesDirectos) await emitir(m);
        }
      } catch (e) {
        console.error(`Herramienta ${c.name} falló:`, e.message);
        resultado = { ok: false, error: "La herramienta no está disponible en este momento." };
      }
      respuestasHerramienta.push({ functionResponse: { name: c.name, response: resultado } });
    }

    contents.push({ role: ROL_HERRAMIENTA, parts: respuestasHerramienta });
  }

  return { mensajes, directos, historial: contents, usadas };
}

// Envoltura que corrige el rol de la respuesta de herramienta si la API
// lo rechaza.
//
// El reintento vuelve a ejecutar la herramienta, así que la primera vez
// que pase puede quedar una fila de más en la bitácora. No se duplica
// ningún mensaje al cliente, porque el error ocurre antes de enviar.
// Pasa una sola vez en la vida del proceso: después, el rol ya es el
// correcto para todas las conversaciones.
export async function conversarSeguro(opciones) {
  try {
    return await conversar(opciones);
  } catch (e) {
    const esRol = e.estado === 400 && /role/i.test(e.cuerpo || "");
    if (!esRol) throw e;
    ROL_HERRAMIENTA = ROL_HERRAMIENTA === "user" ? "function" : "user";
    console.log(`Gemini rechazó el rol de herramienta; reintentando con "${ROL_HERRAMIENTA}".`);
    return await conversar(opciones);
  }
}
