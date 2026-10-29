// =====================================================================
// Cotizador por WhatsApp · Grupo Avándaro × Freelan
//
// LA DIFERENCIA CON LA VOZ
//
// Con Aircall el agente de voz sostiene la conversación: pregunta,
// entiende, junta los datos y nos llama UNA vez con todo. Nosotros solo
// contestamos con un número.
//
// En WhatsApp no hay nadie que sostenga la conversación. Hay que
// recordar que hace tres mensajes dijeron 80 personas, entender que
// "sí, con comida" se refiere al paquete, y saber qué falta por
// preguntar. Eso vive aquí.
//
// POR QUÉ SIN MODELO DE LENGUAJE, POR AHORA
//
// Un modelo haría la conversación más natural, pero mete una llave de
// API más, costo por conversación y una dependencia externa en medio de
// una demo. Esto extrae los datos con reglas, que para el vocabulario de
// una cotización de eventos alcanza bien: fechas, cantidades con su
// unidad, y nombres del catálogo. La costura para meter un modelo
// después está marcada en extraer(): es la única función que habría que
// reemplazar.
//
// LO QUE NUNCA CAMBIA
//
// El precio SIEMPRE sale del mismo motor que usan la voz y HubSpot.
// Aquí no se calcula nada, no se redondea nada y no se estima nada.
// =====================================================================

import { randomUUID } from "node:crypto";
import { createHmac, timingSafeEqual } from "node:crypto";
import { aFechaISO, normaliza, fechaEnLetras, AVISO_FIJO } from "./voz.js";
import * as cerebro from "./cerebro.js";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// Cantidades dichas con letra, que en un chat pasan todo el tiempo.
const NUMEROS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300,
  cuatrocientos: 400, quinientos: 500,
};

const UNIDADES = {
  personas: "personas?|gente|invitad[oa]s|asistentes|pax|comensales|cubiertos",
  dias: "d[ií]as?|jornadas?",
  habitaciones: "habitaciones?|cuartos?|rec[aá]maras?|llaves?",
  noches: "noches?",
};

const SIN_ALIMENTOS = /\b(sin (alimentos|comida|ayb)|no (queremos|vamos a|necesitamos) (comida|alimentos)|nada de comida|solo el sal[oó]n)\b/;
const REINICIO = /\b(otra cotizaci[oó]n|empezar de nuevo|empecemos de nuevo|borrar|reiniciar|nuevo evento|otro evento)\b/;
const SALUDO = /\b(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|qu[eé] tal)\b/;

// ---------------------------------------------------------------------
// Fechas dentro de texto libre
//
// Si no dicen el año, se asume la siguiente vez que ocurre esa fecha.
// Quien escribe en octubre "el 16 de marzo" se refiere al que viene, no
// al que ya pasó.
// ---------------------------------------------------------------------
const dos = (n) => String(n).padStart(2, "0");

export function buscarFecha(texto, hoy = new Date()) {
  const t = normaliza(texto);

  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${dos(m[2])}-${dos(m[3])}`;

  m = /(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(t);
  if (m) return `${m[3]}-${dos(m[2])}-${dos(m[1])}`;

  // Se recorren TODOS los candidatos, no solo el primero. En "500
  // personas en el kiosko el 16 de marzo" el primer intento cae sobre
  // "00 personas", que no es un mes; quedarse ahí perdía la fecha.
  for (const c of t.matchAll(/(\d{1,2})\s*(?:de\s+)?([a-z]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?/g)) {
    const mes = MESES.findIndex((x) => normaliza(x) === c[2]);
    if (mes < 0) continue;
    const dia = Number(c[1]);
    if (dia < 1 || dia > 31) continue;
    if (c[3]) return `${c[3]}-${dos(mes + 1)}-${dos(dia)}`;

    // Sin año, se asume la próxima vez que ocurre. Quien escribe en
    // octubre "el 16 de marzo" habla del que viene.
    let anio = hoy.getFullYear();
    const tentativa = new Date(Date.UTC(anio, mes, dia));
    const corte = new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate()));
    if (tentativa < corte) anio += 1;
    return `${anio}-${dos(mes + 1)}-${dos(dia)}`;
  }
  return undefined;
}

function conUnidad(t, unidad) {
  let m = new RegExp(`(\\d{1,4})\\s*(?:${unidad})\\b`).exec(t);
  if (m) return Number(m[1]);

  m = new RegExp(`([a-z]+)\\s+(?:${unidad})\\b`).exec(t);
  if (m && NUMEROS[m[1]] !== undefined) return NUMEROS[m[1]];

  m = new RegExp(`(?:${unidad})\\b[^\\d]{0,12}(\\d{1,4})`).exec(t);
  if (m) return Number(m[1]);

  return undefined;
}

// Un número suelto, sin unidad. Solo sirve si acabamos de preguntar algo.
function numeroSuelto(t) {
  const m = /^[^\d]{0,12}(\d{1,4})[^\d]{0,12}$/.exec(t.trim());
  if (m) return Number(m[1]);
  const p = t.trim().split(/\s+/);
  if (p.length <= 3) {
    for (const x of p) if (NUMEROS[x] !== undefined) return NUMEROS[x];
  }
  return undefined;
}

// Busca el nombre de un elemento del catálogo dentro del mensaje.
function buscarEnCatalogo(t, lista, campoClave, alias = {}) {
  for (const x of lista) {
    const n = normaliza(x.nombre);
    if (n && n.length > 3 && t.includes(n)) return String(x[campoClave]);
  }
  for (const [patron, clave] of Object.entries(alias)) {
    if (new RegExp(patron).test(t)) return clave;
  }
  return undefined;
}

// ---------------------------------------------------------------------
// LA COSTURA
//
// Esta es la única función que habría que cambiar para poner un modelo
// de lenguaje a entender el mensaje. Todo lo demás, la conversación, la
// cotización y la redacción, se queda igual.
// ---------------------------------------------------------------------
export function extraer(texto, { esperando, catalogos: c, hoy } = {}) {
  const t = normaliza(texto);
  const campos = {};

  const fecha = buscarFecha(texto, hoy);
  if (fecha) campos.fecha_inicio = fecha;

  for (const [campo, unidad] of Object.entries(UNIDADES)) {
    const v = conUnidad(t, unidad);
    if (v !== undefined) campos[campo] = v;
  }

  if (SIN_ALIMENTOS.test(t)) {
    campos.alimentos = null;            // dicho explícitamente, no es un olvido
  } else if (c) {
    // Varios servicios en una sola frase: "desayuno y comida buffet" son
    // dos partidas, no una. Por eso no se usa buscarEnCatalogo, que
    // devuelve una sola clave.
    //
    // El orden importa: lo más específico primero, porque "cena
    // emplatada premium" también encaja con "cena".
    const PISTAS_AYB = [
      [/\bdesayuno\s+emplatad/, "AYB-DESAYUNO_EMPLATADO"],
      [/\bdesayuno/, "AYB-DESAYUNO_BUFFET"],
      [/\bcomida\s+emplatada\s+premium/, "AYB-COMIDA_EMPLATADO_PREMIUM"],
      [/\bcomida\s+emplatad/, "AYB-COMIDA_EMPLATADO_ESTANDAR"],
      [/\bcomida\b/, "AYB-COMIDA_BUFFET"],
      [/\bcena\s+emplatada\s+premium/, "AYB-CENA_EMPLATADO_PREMIUM"],
      [/\bcena\s+emplatad/, "AYB-CENA_EMPLATADO_ESTANDAR"],
      [/\bcena\b/, "AYB-CENA_BUFFET"],
      [/\b(coffee|cafe|cafecito|solo caf)/, "AYB-COFFEE_BREAK_ESTANDAR"],
      [/\bbox\s*lunch/, "AYB-BOX_LUNCH_AVANDARO"],
      [/\bcanap/, "AYB-CANAPES_6"],
      [/\bbarra\s+(de\s+)?cerveza/, "AYB-BARRA_CERVEZAS"],
      [/\b(barra\s+mix|vino y cerveza)/, "AYB-BARRA_MIX"],
      [/\bbarra\s+sin\s+alcohol/, "AYB-BARRA_SIN_ALCOHOL"],
      [/\b(hidrataci|aguas frescas)/, "AYB-BARRA_HIDRATACION"],
      [/\bfogata/, "AYB-FOGATADA_ESTANDAR"],
      [/\btorna\s*fiesta/, "AYB-TORNA_FIESTA_BASICO"],
      [/\bsnack/, "AYB-SNACKS_ADICIONALES"],
      [/\bdescorche/, "AYB-DESCORCHE"],
    ];
    const existe = new Set((c.alimentos ?? []).map((a) => a.clave));
    const halladas = [];
    for (const [patron, clave] of PISTAS_AYB) {
      if (patron.test(t) && existe.has(clave) && !halladas.includes(clave)) {
        halladas.push(clave);
      }
    }
    if (halladas.length) campos.alimentos = halladas;
  }

  if (c) {
    const esp = buscarEnCatalogo(t, c.espacios, "clave", {
      "\\bkiosko\\b": "KIOSKO",
      "\\b(sala de consejo|sala de juntas|junta de consejo)\\b": "SALA-CONSEJO",
      "\\b(terraza|campo de golf|golf)\\b": "TERRAZA-GOLF",
      "\\b(jardin del lago|lago)\\b": "JARDIN-LAGO",
    });
    if (esp) campos.espacio = esp;

    const hab = buscarEnCatalogo(t, c.hospedaje, "tipo_habitacion", {
      "\\b(presidencial)\\b": "HAB-PRESIDENCIAL",
      "\\b(suite|premium|junior)\\b": "HAB-SUITE",
      "\\b(individual|sencilla|una persona)\\b": "HAB-INDIVIDUAL",
      "\\b(doble|estandar|normal|compartida)\\b": "HAB-DOBLE",
    });
    if (hab) campos.tipo_habitacion = hab;
  }

  // Un "80" pelón solo se interpreta si viene contestando una pregunta.
  if (esperando && campos[esperando] === undefined) {
    const n = numeroSuelto(t);
    if (n !== undefined) campos[esperando] = n;
  }

  return {
    campos,
    reinicio: REINICIO.test(t),
    saludo: SALUDO.test(t) && Object.keys(campos).length === 0,
  };
}

// ---------------------------------------------------------------------
// Qué falta por preguntar
//
// El orden no es caprichoso. Fecha y personas son obligatorias para el
// motor. Los alimentos van después porque es lo que más mueve el precio:
// sin paquete la cifra sale muy por debajo y deja una expectativa falsa.
// ---------------------------------------------------------------------
const PREGUNTAS = {
  fecha_inicio: "¿Para qué fecha sería el evento?",
  personas: "¿Cuántas personas calculan?",
  dias: "¿Cuántos días dura el evento?",
  alimentos: "¿Van a querer alimentos? Tenemos desayuno, comida y cena, buffet o emplatados, más coffee break, box lunch, canapés, barras de bebidas, fogatada y torna fiesta. Si no necesitan, me dice y lo cotizo solo con el espacio.",
  habitaciones: "¿Necesitan hospedaje? Si sí, dígame cuántas habitaciones y cuántas noches.",
};

export function siguientePregunta(datos, preguntado = []) {
  for (const campo of ["fecha_inicio", "personas", "dias", "alimentos", "habitaciones"]) {
    const tieneValor = datos[campo] !== undefined;
    const esOpcional = campo === "alimentos" || campo === "habitaciones" || campo === "dias";
    if (tieneValor) continue;
    if (esOpcional && preguntado.includes(campo)) continue;   // se preguntó una vez, no se insiste
    return { campo, texto: PREGUNTAS[campo] };
  }
  return null;
}

// ---------------------------------------------------------------------
// Redacción
// ---------------------------------------------------------------------
const pesos = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(Number(n) || 0);

export function textoCotizacion(c) {
  const l = [];
  l.push(`*Cotización ${c.folio}*`);
  l.push(`${c.espacio.nombre} · temporada ${c.temporada} · día de ${c.tipo_dia}`);
  l.push(`${c.evento.personas} personas · ${c.evento.dias} día(s)` +
    (c.evento.habitaciones ? ` · ${c.evento.habitaciones} habitaciones × ${c.evento.noches} noche(s)` : ""));
  l.push("");
  // etiqueta cuando la hay: los alimentos son varias partidas y el
  // concepto solo dice "Alimentos y bebidas" en todas.
  for (const d of c.desglose) l.push(`${d.etiqueta ?? d.concepto}: ${pesos(d.importe)}`);
  for (const d of c.descuentos) l.push(`${d.descripcion}: −${pesos(d.importe)}`);
  if (c.importes.cargo_servicio) l.push(`Cargo por servicio: ${pesos(c.importes.cargo_servicio)}`);
  // Las actividades con precio por tramo no tienen precio por persona, y
  // decir "sin costo" cuando cuestan treinta y ocho mil pesos era
  // exactamente el tipo de error que no se puede mandar a un cliente.
  for (const e of c.experiencias || []) {
    const unidad = e.modo_cobro === "por_tramo"
      ? `monto cerrado para ${c.evento.personas} personas`
      : e.precio_persona
        ? `${pesos(e.precio_persona)} por persona`
        : "sin costo";
    l.push(`${e.nombre} (${unidad}): ${pesos(e.importe)}`);
  }
  l.push("");
  l.push(`Subtotal: ${pesos(c.importes.subtotal)}`);
  l.push(`Impuestos: ${pesos(c.importes.iva + c.importes.ish)}`);
  if (c.importes.propinas) {
    l.push(`Propinas de camaristas y bellboys: ${pesos(c.importes.propinas)}`);
  }
  l.push(`*Total: ${c.total_texto}*`);
  l.push("");
  l.push(`Anticipo para apartar: ${pesos(c.importes.anticipo)}`);
  if (c.importes.saldo_dias_antes) {
    l.push(`El saldo se cubre ${c.importes.saldo_dias_antes} días antes del evento.`);
  }
  l.push(`Vigencia: ${fechaEnLetras(c.vigencia)}`);
  return l.join("\n");
}

// Los avisos internos no se le mandan a quien pregunta; el de tarifa de
// prueba y el de disponibilidad sí, siempre, en su propio mensaje.
export function avisosChat(c) {
  return (c.avisos || []).filter((a) =>
    !/^TARIFARIO DE PRUEBA/i.test(a) &&
    !/^Las tarifas de hospedaje son/i.test(a) &&   // la otra forma del mismo aviso
    !/^Par[aá]metros pendientes/i.test(a) &&
    !/^Disponibilidad no verificada/i.test(a));
}

// ---------------------------------------------------------------------
// El hilo
// ---------------------------------------------------------------------
const ESTADOS = new Map();          // respaldo en memoria, por si falla Supabase
const VIVE_MS = 6 * 60 * 60 * 1000; // seis horas sin escribir y la conversación se da por cerrada

function estadoNuevo(wa_id) {
  return { wa_id, datos: {}, esperando: null, preguntado: [], actualizado: Date.now() };
}

export async function responderConReglas(entrada, { cliente, cotizar, catalogos, hoy }) {
  const { wa_id, texto, nombre } = entrada;
  let st = ESTADOS.get(wa_id);

  if (!st && cliente) {
    try {
      const filas = await cliente.consultar(
        `conversaciones?select=*&wa_id=eq.${encodeURIComponent(wa_id)}&limit=1`);
      if (filas[0]) {
        st = { wa_id, datos: filas[0].datos || {}, esperando: filas[0].esperando,
               preguntado: filas[0].preguntado || [],
               actualizado: new Date(filas[0].actualizado).getTime() };
      }
    } catch (e) {
      console.error("No se pudo leer la conversación:", e.message);
    }
  }
  if (!st || Date.now() - st.actualizado > VIVE_MS) st = estadoNuevo(wa_id);

  let cat = null;
  try {
    cat = await catalogos();
  } catch (e) {
    console.error("Catálogo no disponible:", e.message);
    return { mensajes: ["Ahorita no puedo consultar el tarifario. Permítame unos minutos y lo intento de nuevo."], estado: st };
  }

  const { campos, reinicio, saludo } = extraer(texto, { esperando: st.esperando, catalogos: cat, hoy });

  if (reinicio) {
    st = estadoNuevo(wa_id);
    return { mensajes: ["Listo, empecemos de nuevo. ¿Para qué fecha sería el evento?"],
             estado: { ...st, esperando: "fecha_inicio" } };
  }

  // null es una respuesta válida para alimentos: significa "sin comida".
  for (const [k, v] of Object.entries(campos)) {
    if (v !== undefined) st.datos[k] = v;
  }
  if (campos.habitaciones !== undefined && st.datos.noches === undefined) st.datos.noches = 1;
  if (st.esperando && campos[st.esperando] !== undefined) {
    st.preguntado = st.preguntado.filter((x) => x !== st.esperando);
  }

  const mensajes = [];
  const vacio = Object.keys(st.datos).length === 0;
  if (saludo && vacio) {
    mensajes.push("Hola, le saluda el área de Grupos y Eventos de Hotel Avándaro. Con gusto le armo una cotización.");
  }

  // Aviso temprano cuando el espacio pedido no cabe de ninguna manera.
  //
  // Esto NO duplica la validación del motor: es a propósito más laxa,
  // porque compara contra el aforo mayor del espacio sin importar el
  // montaje. Solo sirve para no hacer tres preguntas más antes de decir
  // que no. El rechazo con criterio fino sigue siendo del motor.
  if (st.datos.espacio && st.datos.personas) {
    const esp = cat.espacios.find((e) => e.clave === st.datos.espacio);
    const aforos = esp
      ? [esp.cap_auditorio, esp.cap_banquete, esp.cap_coctel, esp.cap_escuela]
          .map(Number).filter(Number.isFinite)
      : [];
    const aforo = aforos.length ? Math.max(...aforos) : 0;
    if (aforo && st.datos.personas > aforo) {
      const quienes = st.datos.personas;
      delete st.datos.espacio;
      st.esperando = "espacio";
      st.actualizado = Date.now();
      return {
        mensajes: [
          `${esp.nombre} acomoda ${aforo} personas como máximo y ustedes serían ${quienes}.`,
          "Con gusto le busco otro espacio que sí acomode al grupo. ¿Se lo propongo?",
        ],
        estado: st,
      };
    }
  }

  const pendiente = siguientePregunta(st.datos, st.preguntado);
  if (pendiente) {
    mensajes.push(pendiente.texto);
    st.esperando = pendiente.campo;
    if (!st.preguntado.includes(pendiente.campo)) st.preguntado.push(pendiente.campo);
    st.actualizado = Date.now();
    return { mensajes, estado: st };
  }

  // Ya hay con qué cotizar.
  const peticion = {
    origen: "whatsapp",
    fecha_inicio: st.datos.fecha_inicio,
    personas: st.datos.personas,
    dias: st.datos.dias ?? 1,
    habitaciones: st.datos.habitaciones ?? 0,
    noches: st.datos.noches ?? 0,
    espacio: st.datos.espacio ?? undefined,
    alimentos: st.datos.alimentos ?? undefined,
    tipo_habitacion: st.datos.tipo_habitacion ?? undefined,
  };

  let salida;
  try {
    salida = await cotizar(peticion);
  } catch (e) {
    console.error("Error al cotizar por WhatsApp:", e);
    salida = { ok: false, errores: [`Error interno: ${e.message}`] };
  }

  if (cliente) {
    try {
      await cliente.insertar("cotizaciones", {
        folio: salida.folio ?? `ERR-${randomUUID().slice(0, 8)}`,
        origen: "whatsapp",
        hubspot_deal: null,
        peticion: { ...peticion, wa_id, nombre: nombre ?? null },
        respuesta: salida,
        total: salida.importes?.total ?? null,
        error: salida.ok ? null : (salida.errores || []).join(" · "),
      });
    } catch (e) {
      console.error("No se pudo escribir la bitácora:", e.message);
    }
  }

  if (!salida.ok) {
    mensajes.push((salida.errores || ["No pude cotizarlo."]).join(" "));
    mensajes.push("¿Quiere que le proponga otra opción que sí acomode a su grupo?");
    // Se suelta el espacio para que pueda proponer otro sin reiniciar.
    delete st.datos.espacio;
    st.esperando = "espacio";
    st.actualizado = Date.now();
    return { mensajes, estado: st };
  }

  mensajes.push(textoCotizacion(salida));
  for (const a of avisosChat(salida)) mensajes.push(a);
  mensajes.push(AVISO_FIJO);

  st.esperando = null;
  st.actualizado = Date.now();
  return { mensajes, estado: st, cotizacion: salida };
}

// =====================================================================
// Camino con modelo de lenguaje
//
// Misma conversación, pero entendida en vez de parseada. Lo que NO
// cambia es de dónde salen las cifras.
// =====================================================================

const SISTEMA = `Atiendes el WhatsApp de Grupos y Eventos de Hotel Avándaro, en Valle de Bravo.

Hablas español de México, de usted, cordial y directo. Mensajes cortos: esto es WhatsApp, no un correo. Una idea por mensaje.

Para cotizar necesitas al menos la fecha de inicio y cuántas personas. Pregunta una cosa a la vez, nunca tres juntas. Si no te han dicho nada de alimentos, pregúntalo antes de cotizar: sin paquete el precio sale muy por debajo y deja al cliente con una expectativa equivocada.

Nunca pidas claves ni códigos de catálogo. La persona dice "una comida completa" o "el salón grande", y tú se lo pasas así a la herramienta, que sabe traducirlo.

REGLA QUE NO SE ROMPE: tú no dices precios. Nunca. Ni aproximados, ni rangos, ni "alrededor de", ni repitiendo una cifra que el cliente mencionó. Los precios los entrega la herramienta cotizar_evento en un mensaje aparte que el cliente recibe directamente de nosotros. Cuando la herramienta te confirme que ya se envió, tú solo comentas brevemente o preguntas lo que sigue, sin repetir ninguna cantidad. Si alguien insiste en que le adelantes un número, explica que lo calculas al momento y pide los datos que falten.

Para preguntas del hotel (horarios, servicios, lugares, actividades) usa consultar_hotel. Si no encuentras algo, dilo con honestidad: que lo confirmas con el equipo. Nunca inventes un horario, un servicio ni una capacidad.

Si preguntan algo que no es de eventos ni del hotel, redirige con amabilidad.`;

const HERRAMIENTAS = [
  {
    name: "cotizar_evento",
    description:
      "Calcula el precio del evento y se lo envía al cliente en un mensaje aparte. " +
      "Úsala en cuanto tengas fecha y número de personas. No te devuelve cifras a ti: " +
      "la cotización le llega al cliente directamente.",
    parameters: {
      type: "object",
      properties: {
        fecha_inicio: { type: "string", description: "Fecha de inicio en AAAA-MM-DD. Si no dijeron el año, usa el próximo que corresponda." },
        personas: { type: "integer", description: "Cuánta gente asiste." },
        dias: { type: "integer", description: "Días que dura el evento. Si no lo dijeron, 1." },
        habitaciones: { type: "integer", description: "Habitaciones necesarias. 0 si no quieren hospedaje." },
        noches: { type: "integer", description: "Noches de hospedaje." },
        espacio: { type: "string", description: "Salón o espacio, con el nombre que usó el cliente. Omítelo si no lo mencionó: el sistema sugiere uno." },
        alimentos: {
          type: "array", items: { type: "string" },
          description:
            "Alimentos y bebidas que pidieron, con el nombre que usaron. Uno por cada servicio: " +
            "desayuno buffet, comida emplatada, cena buffet, coffee break, box lunch, canapés, " +
            "barra de cervezas, fogatada, torna fiesta. Usa ver_catalogo si no sabes cuál es cuál.",
        },
        paquete_ayb: { type: "string", description: "Solo si el cliente pidió un paquete cerrado por nombre. Para alimentos sueltos usa el campo alimentos." },
        tipo_habitacion: { type: "string", description: "Tipo de habitación, si lo mencionó." },
        experiencias: {
          type: "array", items: { type: "string" },
          description:
            "Actividades que pidieron, con el nombre que usaron. Por ejemplo circuito de energía, " +
            "regata, muro de escalar, rally, coaching ejecutivo, hiking, cuatrimoto, RZR, " +
            "Chi Kung, Wim Hof, ritual chamánico, baño de bosque, pizza a ciegas, coctelería.",
        },
      },
      required: ["fecha_inicio", "personas"],
    },
  },
  {
    name: "ver_catalogo",
    description: "Lista los espacios con sus capacidades, los paquetes de alimentos y los tipos de habitación. Úsala cuando pregunten qué opciones hay o si un grupo cabe en algún lugar.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "consultar_hotel",
    description: "Busca información del hotel: servicios, horarios, lugares, actividades, experiencias. Úsala para cualquier pregunta que no sea de precios.",
    parameters: {
      type: "object",
      properties: { busqueda: { type: "string", description: "Qué buscar, en pocas palabras. Por ejemplo: alberca, spa, horario del restaurante." } },
      required: ["busqueda"],
    },
  },
];

// El mapa del esquema kb se descubre una vez y se guarda. Así no hay
// nombres de vistas escritos a mano que se rompan cuando alguien
// reorganice la base de conocimiento.
let kbMapa = null;

// Lo que nunca se consulta para contestarle a alguien de fuera.
// incidencias es nuestra bitácora de huecos en la base: sirve para
// cobrarle pendientes a Avándaro, no para enseñársela a un prospecto.
const INTERNAS = /^(incidencias|servicio_horarios|v_incidencias)$/;

// Columnas que no salen del hotel. El teléfono de un área y el nombre
// de quien la atiende son datos de operación interna; que el agente los
// tenga a la mano es una fuga esperando a pasar.
const COLUMNAS_INTERNAS = new Set([
  "id", "responsable", "whatsapp", "extension", "contacto_reserva",
  "notas_concierge", "estatus_dato", "actualizado",
  "origen_pestana", "origen_fila", "dias_sin_confirmar",
]);

function limpiarFila(fila) {
  const salida = {};
  for (const [k, v] of Object.entries(fila)) {
    if (COLUMNAS_INTERNAS.has(k)) continue;
    if (v === null || v === "") continue;
    salida[k] = v;
  }
  return salida;
}

async function buscarEnHotel(kb, busqueda) {
  if (!kb) return { ok: false, error: "La información del hotel no está conectada todavía." };
  if (!kbMapa) kbMapa = await kb.describir();

  const limpio = String(busqueda || "").replace(/[(),*]/g, " ").trim();
  if (!limpio) return { ok: false, error: "Falta qué buscar." };
  const t = encodeURIComponent(limpio);

  // SOLO las vistas v_, cuando existen.
  //
  // Las vistas son el contrato: filtran lo que está marcado como
  // incompleto y arman los horarios ya validados. Las tablas crudas
  // traen además el dato sin confirmar, que es justo lo que no se le
  // dice a un prospecto. Si se consultan las dos, el filtro no sirve
  // de nada y además se duplica todo.
  const todas = Object.entries(kbMapa);
  const hayVistas = todas.some(([t]) => t.startsWith("v_"));
  const porRevisar = (hayVistas ? todas.filter(([t]) => t.startsWith("v_")) : todas)
    .filter(([t]) => !INTERNAS.test(t))
    .slice(0, 10);

  const hallazgos = [];
  for (const [tabla, info] of porRevisar) {
    if (hallazgos.length >= 6) break;
    if (!info.texto.length) continue;
    const o = info.texto.map((c) => `${c}.ilike.*${t}*`).join(",");
    try {
      const filas = await kb.consultar(`${tabla}?select=*&or=(${o})&limit=3`);
      for (const f of filas) hallazgos.push(limpiarFila(f));
    } catch { /* una vista que no admita el filtro no debe tumbar la búsqueda */ }
  }

  if (!hallazgos.length) {
    return { ok: true, encontrado: false,
             instruccion: "No hay nada sobre eso en la base. Dile al cliente que lo confirmas con el equipo. No lo inventes." };
  }
  return { ok: true, encontrado: true, resultados: hallazgos.slice(0, 6) };
}

function hacerEjecutor({ st, cliente, kb, cotizar, catalogos, wa_id, nombre }) {
  return async (herramienta, args) => {
    if (herramienta === "ver_catalogo") {
      const c = await catalogos();
      return { resultado: {
        ok: true,
        espacios: c.espacios.map((e) => ({ nombre: e.nombre, tipo: e.tipo, interior: e.interior,
          cabe_banquete: e.cap_banquete, cabe_coctel: e.cap_coctel, cabe_auditorio: e.cap_auditorio })),
        habitaciones: [...new Set(c.hospedaje.map((h) => h.nombre))],
        // Nada de esto lleva precio, a propósito: el modelo nunca ve una
        // cifra. La cotización la emite cotizar_evento con el texto ya
        // armado por nuestro código.
        alimentos: (c.alimentos ?? []).map((a) => ({
          nombre: a.nombre, tipo: a.subgrupo ?? "Comidas",
          que_es: a.descripcion,
          minimo_personas: a.minimo_personas ?? null,
        })),
        actividades: (c.experiencias ?? []).map((e) => ({
          nombre: e.nombre, categoria: e.categoria,
          duracion: e.duracion_horas ? `${e.duracion_horas} h` : e.duracion,
          para_que: e.descripcion,
          hasta_personas: e.maximo_personas ?? null,
        })),
        paquetes: c.paquetes.map((p) => ({ nombre: p.nombre, incluye: p.incluye })),
        instruccion:
          "No menciones precios de este catálogo aunque los veas: aquí no hay ninguno, " +
          "y la cotización la manda cotizar_evento en un mensaje aparte. " +
          "Puedes describir alimentos y actividades y agruparlos por lo que el cliente busca. " +
          "Si una actividad trae hasta_personas y el grupo es más grande, dilo antes de ofrecerla. " +
          "Nunca estimes una cifra tú.",
      } };
    }

    if (herramienta === "consultar_hotel") {
      return { resultado: await buscarEnHotel(kb, args.busqueda) };
    }

    if (herramienta !== "cotizar_evento") {
      return { resultado: { ok: false, error: "Herramienta desconocida." } };
    }

    const peticion = {
      origen: "whatsapp",
      fecha_inicio: aFechaISO(args.fecha_inicio),
      personas: args.personas,
      dias: args.dias ?? 1,
      habitaciones: args.habitaciones ?? 0,
      noches: args.noches ?? (args.habitaciones ? 1 : 0),
      espacio: args.espacio || undefined,
      alimentos: args.alimentos || undefined,
      paquete_ayb: args.paquete_ayb || undefined,
      tipo_habitacion: args.tipo_habitacion || undefined,
      experiencias: args.experiencias || undefined,
    };
    Object.assign(st.datos, {
      fecha_inicio: peticion.fecha_inicio, personas: peticion.personas,
      dias: peticion.dias, habitaciones: peticion.habitaciones, noches: peticion.noches,
    });

    let salida;
    try {
      salida = await cotizar(peticion);
    } catch (e) {
      console.error("Error al cotizar:", e);
      salida = { ok: false, errores: [`Error interno: ${e.message}`] };
    }

    if (cliente) {
      try {
        await cliente.insertar("cotizaciones", {
          folio: salida.folio ?? `ERR-${randomUUID().slice(0, 8)}`,
          origen: "whatsapp",
          hubspot_deal: null,
          peticion: { ...peticion, wa_id, nombre: nombre ?? null, via: "gemini" },
          respuesta: salida,
          total: salida.importes?.total ?? null,
          error: salida.ok ? null : (salida.errores || []).join(" · "),
        });
      } catch (e) {
        console.error("No se pudo escribir la bitácora:", e.message);
      }
    }

    if (!salida.ok) {
      return { resultado: { ok: false, entregada: false,
        motivo: (salida.errores || ["No se pudo cotizar."]).join(" "),
        instruccion: "Explícaselo al cliente con tus palabras y pide o corrige el dato que haga falta. No des ninguna cifra." } };
    }

    // AQUÍ ESTÁ EL CANDADO: el modelo recibe un acuse sin un solo
    // número. Las cifras van en mensajesDirectos, que salen tal como
    // las calculó el motor, sin pasar por el modelo.
    return {
      mensajesDirectos: [textoCotizacion(salida), ...avisosChat(salida), AVISO_FIJO],
      resultado: {
        ok: true,
        entregada: true,
        folio: salida.folio,
        espacio: salida.espacio.nombre,
        instruccion: "La cotización completa YA se le envió al cliente en mensajes aparte. " +
          "NO repitas ni menciones ninguna cantidad. Comenta brevemente y pregunta si quiere " +
          "ajustar algo o si tiene dudas.",
      },
    };
  };
}

async function cargarEstado(wa_id, cliente) {
  let st = ESTADOS.get(wa_id);
  if (!st && cliente) {
    try {
      const filas = await cliente.consultar(
        `conversaciones?select=*&wa_id=eq.${encodeURIComponent(wa_id)}&limit=1`);
      if (filas[0]) {
        const { _historial, ...datos } = filas[0].datos || {};
        st = { wa_id, datos, historial: _historial || [],
               esperando: filas[0].esperando, preguntado: filas[0].preguntado || [],
               actualizado: new Date(filas[0].actualizado).getTime() };
      }
    } catch (e) {
      console.error("No se pudo leer la conversación:", e.message);
    }
  }
  if (!st || Date.now() - st.actualizado > VIVE_MS) st = estadoNuevo(wa_id);
  if (!st.historial) st.historial = [];
  return st;
}

export async function responderConIA(entrada, { cliente, kb, cotizar, catalogos, emitir }) {
  const { wa_id, texto, nombre } = entrada;
  const st = await cargarEstado(wa_id, cliente);

  if (REINICIO.test(normaliza(texto))) {
    const nuevo = estadoNuevo(wa_id);
    nuevo.historial = [];
    return { mensajes: ["Listo, empecemos de nuevo. ¿Para qué fecha sería el evento?"], estado: nuevo };
  }

  const salida = await cerebro.conversarSeguro({
    historial: cerebro.recortar(st.historial, 16),
    mensaje: texto,
    sistema: SISTEMA + `\n\nHoy es ${new Date().toISOString().slice(0, 10)}.`,
    herramientas: HERRAMIENTAS,
    ejecutar: hacerEjecutor({ st, cliente, kb, cotizar, catalogos, wa_id, nombre }),
    emitir,
  });

  st.historial = cerebro.recortar(salida.historial, 16);
  st.actualizado = Date.now();

  // Si hay por dónde enviar sobre la marcha, las cifras ya salieron
  // mientras el modelo redactaba, y aquí solo queda su comentario.
  // Sin esa vía (el simulador), se devuelve todo junto y en orden.
  const mensajes = emitir ? [...salida.mensajes] : [...salida.directos, ...salida.mensajes];
  if (!mensajes.length && !salida.directos.length) {
    mensajes.push("Disculpe, no entendí. ¿Me repite qué necesita?");
  }

  return { mensajes, estado: st, via: "gemini", herramientas: salida.usadas };
}

// Despacho.
//
// La capa de reglas es el respaldo, pero SOLO al empezar. A media
// conversación no sirve: tiene su propia memoria, distinta de la del
// modelo, así que contesta ignorando lo que la persona ya dijo y el
// modelo, al volver, vuelve a preguntar lo mismo. Dos motores
// alternándose se sienten peor que uno fallando con honestidad.
//
// Si el modelo falla con un hilo ya abierto, se pide repetir. El
// historial queda intacto y la siguiente vuelta continúa donde iba.
export async function responder(entrada, deps) {
  if (!cerebro.disponible()) return responderConReglas(entrada, deps);

  const st = await cargarEstado(entrada.wa_id, deps.cliente);
  const hiloAbierto = (st.historial?.length ?? 0) > 0;

  try {
    return await responderConIA(entrada, deps);
  } catch (e) {
    console.error("El cerebro falló:", e.message);
    if (!hiloAbierto) {
      console.log("Hilo nuevo: contesta la capa de reglas.");
      return responderConReglas(entrada, deps);
    }
    return {
      mensajes: ["Disculpe, se me trabó el sistema un momento. ¿Me repite lo último, por favor?"],
      estado: st,
      via: "respaldo",
    };
  }
}

async function persistir(cliente, st) {
  if (!cliente) return;
  try {
    await cliente.guardar("conversaciones", {
      wa_id: st.wa_id,
      // El historial del modelo viaja dentro de datos para no pedir una
      // columna más y una migración a media noche.
      datos: st.historial?.length ? { ...st.datos, _historial: cerebro.recortar(st.historial, 16) } : st.datos,
      esperando: st.esperando,
      preguntado: st.preguntado,
      actualizado: new Date(st.actualizado).toISOString(),
    }, "wa_id");
  } catch (e) {
    console.error("No se pudo guardar la conversación:", e.message);
  }
}

// ---------------------------------------------------------------------
// Salida hacia Meta
// ---------------------------------------------------------------------
// El uno de más de México.
//
// Los móviles mexicanos arrastran una herencia vieja de WhatsApp: el
// webhook entrega el número como 521 + diez dígitos, mientras que la
// lista de destinatarios y el resto de la API lo tienen como 52 + diez.
// Contestarle al que nos llegó da "Recipient phone number not in
// allowed list" aunque el número esté perfectamente dado de alta.
//
// Devuelve las dos formas, la preferida primero, para poder reintentar.
export function variantesDestino(numero) {
  const n = String(numero || "").replace(/\D/g, "");
  if (/^521\d{10}$/.test(n)) return [n.replace(/^521/, "52"), n];
  if (/^52\d{10}$/.test(n)) return [n, n.replace(/^52/, "521")];
  return [n];
}

// Palomitas azules de inmediato. No acelera la respuesta, pero la
// espera se siente distinta cuando sabes que del otro lado ya leyeron.
async function marcarLeido(config, id) {
  if (!config.phoneNumberId || !config.graphToken || !id) return;
  const version = config.graphVersion || process.env.WA_GRAPH_VERSION || "v25.0";
  try {
    await fetch(`https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.graphToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: id }),
    });
  } catch { /* es cosmético: que nunca estorbe la respuesta */ }
}

async function enviar(config, para, texto) {
  if (!config.phoneNumberId || !config.graphToken) {
    console.log(`[simulado → ${para}] ${texto.slice(0, 80)}`);
    return;
  }
  // La versión va por variable: Meta retira versiones de la Graph API
  // cada dos años, y dejarla fija en el código significa que un día
  // deja de enviar sin que nadie haya tocado nada.
  const version = config.graphVersion || process.env.WA_GRAPH_VERSION || "v25.0";
  const url = `https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`;

  // Se intenta la forma preferida y, si Meta dice que el destinatario
  // no está en la lista, la otra. Así no dependemos de adivinar cuál
  // de los dos formatos quedó registrado.
  const intentos = variantesDestino(para);
  for (let i = 0; i < intentos.length; i++) {
    const destino = intentos[i];
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.graphToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: destino,
        type: "text",
        text: { preview_url: false, body: texto },
      }),
    });
    if (r.ok) {
      if (i > 0) console.log(`Enviado a ${destino} tras reintento de formato.`);
      return;
    }
    const cuerpo = await r.text();
    const esListaBlanca = /131030/.test(cuerpo);
    if (esListaBlanca && i < intentos.length - 1) {
      console.log(`${destino} no está en la lista; se reintenta con otro formato.`);
      continue;
    }
    console.error("WhatsApp rechazó el envío:", r.status, cuerpo);
    return;
  }
}

// Meta firma cada entrega. Sin esta comprobación, cualquiera que
// adivine la URL puede inyectar conversaciones en la bitácora.
function firmaValida(req, appSecret) {
  if (!appSecret) return true;                  // sin secreto configurado no se exige
  const dada = req.get("x-hub-signature-256") || "";
  if (!dada.startsWith("sha256=")) return false;
  const esperada = "sha256=" + createHmac("sha256", appSecret)
    .update(req.rawBody ?? Buffer.from("")).digest("hex");
  const a = Buffer.from(dada), b = Buffer.from(esperada);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function montar(app, { cliente, kb, token, cotizar, catalogos, config = {} }) {
  const deps = { cliente, kb, cotizar, catalogos };

  // Diagnóstico del cerebro. Los nombres de modelo de Google cambian
  // seguido; esto dice cuáles acepta la llave sin tener que adivinar.
  app.get("/whatsapp/modelos/:token", async (req, res) => {
    if (req.params.token !== token) return res.status(401).json({ error: "token inválido" });
    if (!cerebro.disponible()) return res.json({ ok: false, motivo: "No hay GEMINI_API_KEY; se contesta con reglas." });
    try {
      res.json({ ok: true, usando: cerebro.MODELO_POR_DEFECTO, disponibles: await cerebro.listarModelos() });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // Sonda de la base de conocimiento: qué vistas descubrió y qué
  // devuelve una búsqueda. Sin esto, cuando el agente dice "no lo
  // tengo" no hay forma de saber si es que no está el dato o si no
  // estamos mirando donde debemos.
  app.get("/whatsapp/kb/:token", async (req, res) => {
    if (req.params.token !== token) return res.status(401).json({ error: "token inválido" });
    if (!kb) return res.json({ ok: false, motivo: "El esquema kb no está conectado." });
    try {
      kbMapa = await kb.describir();   // se refresca a propósito
      const salida = {
        ok: true,
        vistas: Object.fromEntries(Object.entries(kbMapa).map(([t, i]) => [t, i.texto])),
      };
      if (req.query.busqueda) {
        salida.busqueda = req.query.busqueda;
        salida.resultado = await buscarEnHotel(kb, String(req.query.busqueda));
      }
      res.json(salida);
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  // Sonda: prueba uno o varios modelos, con y sin herramientas, para
  // aislar qué se atora. Los modelos van separados por coma.
  //
  //   /whatsapp/probar/<token>?modelos=a,b,c&sistema=1&herramientas=1
  app.get("/whatsapp/probar/:token", async (req, res) => {
    if (req.params.token !== token) return res.status(401).json({ error: "token inválido" });
    if (!cerebro.disponible()) return res.json({ ok: false, motivo: "No hay GEMINI_API_KEY." });

    const modelos = String(req.query.modelos || cerebro.MODELO_POR_DEFECTO)
      .split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);

    const salida = [];
    for (const modelo of modelos) {
      salida.push(await cerebro.probar({
        modelo,
        sistema: req.query.sistema === "1",
        herramientas: req.query.herramientas === "1" ? HERRAMIENTAS : null,
      }));
    }
    res.json({ ok: true, pruebas: salida });
  });

  // ---------------------------------------------------------------------
  // Salud del token de Meta
  //
  // Antes la única forma de saber si el token servía era escribirle al
  // número y esperar. Eso ya nos costó una hora: el token temporal
  // había expirado en menos de dos horas por estar atado a la sesión
  // del navegador, y el síntoma fue un 401 sin más contexto.
  //
  // Esto hace un GET inofensivo al número y reporta si responde. Nunca
  // devuelve el token ni parte de él, ni al que llama ni al log: solo
  // cuántos caracteres mide, que basta para distinguir un token de
  // sistema de uno temporal sin revelar nada.
  // ---------------------------------------------------------------------
  app.get("/whatsapp/meta/:token", async (req, res) => {
    if (req.params.token !== token) return res.status(401).json({ error: "token inválido" });
    if (!config.graphToken || !config.phoneNumberId) {
      return res.json({ ok: false,
        motivo: "Falta WA_GRAPH_TOKEN o WA_PHONE_ID en el entorno." });
    }

    const version = config.graphVersion || process.env.WA_GRAPH_VERSION || "v25.0";
    const campos = "display_phone_number,verified_name,quality_rating,platform_type";
    const url = `https://graph.facebook.com/${version}/${config.phoneNumberId}` +
                `?fields=${campos}`;
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${config.graphToken}` },
        signal: AbortSignal.timeout(10000),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = cuerpo?.error ?? {};
        return res.json({
          ok: false,
          http: r.status,
          codigo: e.code ?? null,
          subcodigo: e.error_subcode ?? null,
          mensaje: e.message ?? null,
          // 190 con subcódigo 463 es exactamente el caso de un token
          // temporal vencido, y conviene nombrarlo en lugar de dejar
          // que alguien lo confunda con permisos faltantes.
          pista: e.code === 190
            ? (e.error_subcode === 463
                ? "El token venció. Si es temporal, dura lo que la sesión del navegador: hay que generar uno de sistema sin vencimiento."
                : "Token inválido o revocado.")
            : e.code === 200 ? "El token es válido pero le faltan permisos sobre este número."
            : null,
          largo_del_token: String(config.graphToken).length,
        });
      }
      res.json({
        ok: true,
        numero: cuerpo.display_phone_number ?? null,
        nombre: cuerpo.verified_name ?? null,
        calidad: cuerpo.quality_rating ?? null,
        tipo: cuerpo.platform_type ?? null,
        version_graph: version,
        largo_del_token: String(config.graphToken).length,
      });
    } catch (e) {
      res.json({ ok: false, motivo: `No se pudo consultar a Meta: ${e.message}` });
    }
  });

  // Alta del webhook en el panel de Meta.
  app.get("/whatsapp/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" &&
        req.query["hub.verify_token"] === config.verifyToken) {
      return res.status(200).send(String(req.query["hub.challenge"] ?? ""));
    }
    res.sendStatus(403);
  });

  app.post("/whatsapp/webhook", async (req, res) => {
    if (!firmaValida(req, config.appSecret)) {
      console.error("Firma de WhatsApp inválida; entrega descartada.");
      return res.sendStatus(401);
    }
    // Se contesta de inmediato: si Meta no recibe 200 en segundos,
    // reintenta y la conversación se duplica.
    res.sendStatus(200);

    try {
      for (const entrada of req.body?.entry ?? []) {
        for (const cambio of entrada.changes ?? []) {
          const v = cambio.value ?? {};
          for (const msg of v.messages ?? []) {
            if (msg.type !== "text") {
              await enviar(config, msg.from,
                "Por ahora solo puedo leer mensajes de texto. ¿Me escribe la fecha y cuántas personas?");
              continue;
            }
            const nombre = v.contacts?.[0]?.profile?.name;

            // Sin await: las palomitas azules salen mientras pensamos.
            marcarLeido(config, msg.id);

            const r = await responder(
              { wa_id: msg.from, texto: msg.text.body, nombre },
              { ...deps, emitir: (m) => enviar(config, msg.from, m) });

            for (const m of r.mensajes) await enviar(config, msg.from, m);

            // Guardar va al final y sin esperarlo: es para la siguiente
            // vuelta, no para esta, y nadie debe esperar por ello.
            persistir(cliente, r.estado).catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("Error procesando mensaje de WhatsApp:", e);
    }
  });

  // -------------------------------------------------------------------
  // Simulador
  //
  // La misma lógica del webhook, sin Meta de por medio. Sirve para
  // probar la conversación completa hoy, y para enseñarla sin depender
  // de que la red del lugar deje pasar WhatsApp.
  // -------------------------------------------------------------------
  app.post("/whatsapp/simular/:token", async (req, res) => {
    if (req.params.token !== token) return res.status(401).json({ error: "token inválido" });
    const { de = "simulador", texto = "", reiniciar } = req.body ?? {};

    // Borrar solo la memoria no alcanza: el estado también vive en
    // Supabase, y al releerlo volvían los datos de la conversación
    // anterior. Hay que limpiar los dos.
    if (reiniciar) {
      ESTADOS.delete(de);
      if (cliente) {
        try {
          await cliente.guardar("conversaciones", {
            wa_id: de, datos: {}, esperando: null, preguntado: [],
            actualizado: new Date().toISOString(),
          }, "wa_id");
        } catch (e) {
          console.error("No se pudo limpiar la conversación:", e.message);
        }
      }
    }
    try {
      const r = await responder({ wa_id: de, texto, nombre: "Simulador" }, deps);
      ESTADOS.set(de, r.estado);
      await persistir(cliente, r.estado);
      res.json({
        ok: true,
        via: r.via ?? "reglas",
        herramientas: r.herramientas ?? [],
        mensajes: r.mensajes,
        datos: r.estado.datos,
        esperando: r.estado.esperando ?? null,
        folio: r.cotizacion?.folio ?? null,
      });
    } catch (e) {
      console.error("Simulador:", e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return [
    "GET  /whatsapp/webhook  (verificación de Meta)",
    "POST /whatsapp/webhook  (firmado)",
    "POST /whatsapp/simular/:token",
    "GET  /whatsapp/modelos/:token",
    "GET  /whatsapp/probar/:token",
    "GET  /whatsapp/kb/:token",
    "GET  /whatsapp/meta/:token  (salud del token de Meta)",
  ];
}