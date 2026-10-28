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
    campos.paquete_ayb = null;          // dicho explícitamente, no es un olvido
  } else if (c) {
    const paq = buscarEnCatalogo(t, c.paquetes, "clave", {
      "\\b(coffee|cafe|cafecito|solo caf)": "PAQ-COFFEE",
      "\\b(ejecutiv)": "PAQ-EJECUTIVO",
      "\\b(banquete|cena de|boda)": "PAQ-BANQUETE",
      "\\b(todo incluido|barra libre|open bar)": "PAQ-TODO",
    });
    if (paq) campos.paquete_ayb = paq;
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
      "\\b(junior|suite)\\b": "HAB-JUNIOR",
      "\\b(estandar|sencilla|normal)\\b": "HAB-ESTANDAR",
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
  paquete_ayb: "¿Van a querer alimentos? Tenemos coffee break, paquete ejecutivo, banquete y todo incluido. Si no necesitan, me dice y lo cotizo solo con el espacio.",
  habitaciones: "¿Necesitan hospedaje? Si sí, dígame cuántas habitaciones y cuántas noches.",
};

export function siguientePregunta(datos, preguntado = []) {
  for (const campo of ["fecha_inicio", "personas", "dias", "paquete_ayb", "habitaciones"]) {
    const tieneValor = datos[campo] !== undefined;
    const esOpcional = campo === "paquete_ayb" || campo === "habitaciones" || campo === "dias";
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
  for (const d of c.desglose) l.push(`${d.concepto}: ${pesos(d.importe)}`);
  for (const d of c.descuentos) l.push(`${d.descripcion}: −${pesos(d.importe)}`);
  if (c.importes.cargo_servicio) l.push(`Cargo por servicio: ${pesos(c.importes.cargo_servicio)}`);
  l.push("");
  l.push(`Subtotal: ${pesos(c.importes.subtotal)}`);
  l.push(`Impuestos: ${pesos(c.importes.iva + c.importes.ish)}`);
  l.push(`*Total: ${c.total_texto}*`);
  l.push("");
  l.push(`Anticipo para apartar: ${pesos(c.importes.anticipo)}`);
  l.push(`Vigencia: ${fechaEnLetras(c.vigencia)}`);
  return l.join("\n");
}

// Los avisos internos no se le mandan a quien pregunta; el de tarifa de
// prueba y el de disponibilidad sí, siempre, en su propio mensaje.
export function avisosChat(c) {
  return (c.avisos || []).filter((a) =>
    !/^TARIFARIO DE PRUEBA/i.test(a) &&
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
    paquete_ayb: st.datos.paquete_ayb ?? undefined,
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
        paquete_ayb: { type: "string", description: "Paquete de alimentos como lo dijo el cliente. Omítelo solo si dijo que no quiere alimentos." },
        tipo_habitacion: { type: "string", description: "Tipo de habitación, si lo mencionó." },
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
        paquetes: c.paquetes.map((p) => ({ nombre: p.nombre, incluye: p.incluye })),
        habitaciones: [...new Set(c.hospedaje.map((h) => h.nombre))],
        instruccion: "No menciones precios de este catálogo aunque los veas.",
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
      paquete_ayb: args.paquete_ayb || undefined,
      tipo_habitacion: args.tipo_habitacion || undefined,
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

export async function responderConIA(entrada, { cliente, kb, cotizar, catalogos }) {
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
  });

  st.historial = cerebro.recortar(salida.historial, 16);
  st.actualizado = Date.now();

  // Primero las cifras que calculó el motor, después el comentario del
  // modelo. Al revés, el cliente lee "ahí le va" antes de tener nada.
  const mensajes = [...salida.directos, ...salida.mensajes];
  if (!mensajes.length) mensajes.push("Disculpe, no entendí. ¿Me repite qué necesita?");

  return { mensajes, estado: st, via: "gemini", herramientas: salida.usadas };
}

// Despacho. Si no hay llave, o si el modelo falla, la capa de reglas
// contesta igual. El demo no se cae porque Google tenga un mal día.
export async function responder(entrada, deps) {
  if (!cerebro.disponible()) return responderConReglas(entrada, deps);
  try {
    return await responderConIA(entrada, deps);
  } catch (e) {
    console.error("El cerebro falló, se contesta con reglas:", e.message);
    return responderConReglas(entrada, deps);
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
async function enviar(config, para, texto) {
  if (!config.phoneNumberId || !config.graphToken) {
    console.log(`[simulado → ${para}] ${texto.slice(0, 80)}`);
    return;
  }
  // La versión va por variable: Meta retira versiones de la Graph API
  // cada dos años, y dejarla fija en el código significa que un día
  // deja de enviar sin que nadie haya tocado nada.
  const version = config.graphVersion || process.env.WA_GRAPH_VERSION || "v25.0";
  const r = await fetch(`https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.graphToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "text",
      text: { preview_url: false, body: texto },
    }),
  });
  if (!r.ok) console.error("WhatsApp rechazó el envío:", r.status, await r.text());
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
            const r = await responder(
              { wa_id: msg.from, texto: msg.text.body, nombre }, deps);
            await persistir(cliente, r.estado);
            for (const m of r.mensajes) await enviar(config, msg.from, m);
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
  ];
}
