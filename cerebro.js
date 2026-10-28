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

    const respuesta = await generar(cuerpo, modelo, llave);
    const ps = partes(respuesta);

    const llamadas = ps.filter((p) => p.functionCall).map((p) => p.functionCall);
    const textos = ps.filter((p) => p.text).map((p) => p.text.trim()).filter(Boolean);

    if (!llamadas.length) {
      if (textos.length) {
        mensajes.push(...textos);
        contents.push({ role: "model", parts: textos.map((t) => ({ text: t })) });
      }
      break;
    }

    // El modelo pidió herramientas. Se registran y se ejecutan.
    contents.push({ role: "model", parts: llamadas.map((c) => ({ functionCall: c })) });

    const respuestasHerramienta = [];
    for (const c of llamadas) {
      usadas.push(c.name);
      let resultado;
      try {
        const salida = await ejecutar(c.name, c.args || {});
        resultado = salida?.resultado ?? salida ?? {};
        if (salida?.mensajesDirectos?.length) directos.push(...salida.mensajesDirectos);
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
