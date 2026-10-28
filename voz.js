// =====================================================================
// Capa de voz · Cotizador Inteligente
//
// POR QUÉ EXISTE
//
// El cotizador devuelve un desglose completo: conceptos, unitarios,
// impuestos separados, cuatro avisos. Eso sirve para un correo o para
// escribirlo en el negocio de HubSpot. Dicho en voz alta por teléfono
// es ilegible: nadie retiene nueve renglones de cifras escuchándolos
// una sola vez.
//
// Esta capa traduce la misma cotización a algo que una persona pueda
// entender de oído:
//
//   - Las cantidades van en letra. "$876,428.00" leído por un sintetizador
//     puede salir como "ochocientos setenta y seis coma cuatrocientos
//     veintiocho" o colarle la palabra dólares. En letra no hay duda.
//   - Las fechas en letra, por lo mismo: "2026-11-10" no se dice.
//   - Los centavos se van. Por teléfono son ruido.
//   - De los cuatro avisos sobreviven los que le importan a quien llama.
//     Que falte confirmar el IVA con Avándaro es un pendiente nuestro,
//     no algo que el agente deba recitarle a un prospecto. Que la tarifa
//     sea de prueba, en cambio, SÍ se dice siempre.
// =====================================================================

const UNIDADES = ["", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho",
  "nueve", "diez", "once", "doce", "trece", "catorce", "quince", "dieciséis",
  "diecisiete", "dieciocho", "diecinueve", "veinte", "veintiuno", "veintidós",
  "veintitrés", "veinticuatro", "veinticinco", "veintiséis", "veintisiete",
  "veintiocho", "veintinueve"];

const DECENAS = ["", "", "", "treinta", "cuarenta", "cincuenta", "sesenta",
  "setenta", "ochenta", "noventa"];

const CENTENAS = ["", "ciento", "doscientos", "trescientos", "cuatrocientos",
  "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos"];

export const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
  "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function hasta999(n) {
  if (n === 0) return "";
  if (n === 100) return "cien";
  const c = Math.floor(n / 100);
  const r = n % 100;
  let texto = c ? CENTENAS[c] : "";
  if (r) {
    const resto = r < 30
      ? UNIDADES[r]
      : DECENAS[Math.floor(r / 10)] + (r % 10 ? ` y ${UNIDADES[r % 10]}` : "");
    texto = texto ? `${texto} ${resto}` : resto;
  }
  return texto;
}

// "veintiuno pesos" y "veintiuno mil" no existen: antes de sustantivo
// masculino se apocopa. El acento lo lleva solo "veintiún", porque es
// una sola palabra con el golpe al final; se escribe "treinta y un mil",
// no "treinta y ún mil".
const apocopa = (texto) => texto
  .replace(/veintiuno$/, "veintiún")
  .replace(/uno$/, "un");

export function numeroALetras(valor) {
  const n = Math.round(Number(valor) || 0);
  if (n === 0) return "cero";
  if (n < 0) return `menos ${numeroALetras(-n)}`;

  const millones = Math.floor(n / 1e6);
  const miles = Math.floor((n % 1e6) / 1000);
  const resto = n % 1000;
  const partes = [];

  if (millones) {
    partes.push(millones === 1 ? "un millón" : `${hasta999(millones)} millones`);
  }
  if (miles) partes.push(miles === 1 ? "mil" : `${apocopa(hasta999(miles))} mil`);
  if (resto) partes.push(hasta999(resto));

  return partes.join(" ");
}

export function pesosEnLetras(valor) {
  const entero = Math.round(Number(valor) || 0);
  if (entero === 1) return "un peso";
  const letras = apocopa(numeroALetras(entero));
  // Un millón redondo pide "de": "dos millones DE pesos". Con resto no:
  // "dos millones quinientos mil pesos".
  return /mill(ón|ones)$/.test(letras) ? `${letras} de pesos` : `${letras} pesos`;
}

export function fechaEnLetras(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ""));
  if (!m) return String(iso ?? "");
  return `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`;
}

// ---------------------------------------------------------------------
// Fechas que llegan hablando
//
// El agente de Aircall recolecta la fecha de lo que dice quien llama.
// Aunque se le pida formato AAAA-MM-DD en los parámetros, conviene
// aceptar las formas en que de verdad va a llegar en vez de rebotarlas.
// ---------------------------------------------------------------------
export function aFechaISO(valor) {
  if (valor === null || valor === undefined || valor === "") return undefined;
  const s = String(valor).trim().toLowerCase();

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;

  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);          // 16/03/2027
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;

  m = /^(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s*(?:de\s+)?(\d{4})$/.exec(s);
  if (m) {
    const i = MESES.indexOf(m[2]);
    if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }

  if (/^\d{10,}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);

  return String(valor).trim();   // que el motor lo rechace y diga por qué
}

export function aNumero(valor) {
  if (valor === null || valor === undefined || valor === "") return undefined;
  const limpio = String(valor).replace(/[^\d.-]/g, "");
  // Sin un solo dígito no hay número. Sin esta guarda, "no sé" se
  // convertía en cero y el motor cotizaba un evento de cero personas
  // en vez de pedir el dato.
  if (!/\d/.test(limpio)) return undefined;
  const n = Number(limpio);
  return Number.isFinite(n) ? n : undefined;
}

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

export const normaliza = (s) =>
  String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// ---------------------------------------------------------------------
// Claves de catálogo dichas en voz alta
//
// El motor busca por clave exacta: PAQ-EJECUTIVO, SALON-CENTRO. Nadie
// dice eso por teléfono. Quien llama dice "el ejecutivo" o "una comida
// completa", y el agente va a mandar justamente eso. Aquí se traduce
// contra el catálogo antes de cotizar.
//
// Si no empata con nada se devuelve lo que llegó, para que el motor lo
// rechace con un mensaje que diga qué no existe, en vez de que aquí se
// adivine un paquete que nadie pidió.
// ---------------------------------------------------------------------
const NEGACIONES = /^(no|sin|ninguno|ninguna|nada|nel)\b/;

export function resolverClave(valor, lista, campoClave) {
  if (valor === null || valor === undefined) return undefined;
  const texto = String(valor).trim();
  if (!texto) return undefined;
  if (NEGACIONES.test(normaliza(texto))) return undefined;

  const sn = normaliza(texto);
  const clave = (x) => String(x[campoClave]);

  const exacto = lista.find((x) => normaliza(clave(x)) === sn);
  if (exacto) return clave(exacto);

  const porNombre = lista.find((x) => {
    const n = normaliza(x.nombre);
    return n && (n === sn || n.includes(sn) || sn.includes(n));
  });
  return porNombre ? clave(porNombre) : texto;
}

// ---------------------------------------------------------------------
// El resumen que el agente dice en voz alta
// ---------------------------------------------------------------------
export function resumenVoz(c) {
  const e = c.evento;
  const i = c.importes;

  const partes = [`Para ${plural(e.personas, "persona", "personas")} en ${c.espacio.nombre}`,
                  plural(e.dias, "día", "días")];
  if (e.habitaciones) {
    partes.push(`con ${plural(e.habitaciones, "habitación", "habitaciones")} por ${plural(e.noches, "noche", "noches")}`);
  }

  let texto = `${partes.join(", ")}, el total queda en ${pesosEnLetras(i.total)}, impuestos incluidos.`;

  if (c.descuentos?.length && i.descuento_total > 0) {
    texto += ` Ya trae aplicado un descuento de ${pesosEnLetras(i.descuento_total)}.`;
  }

  texto += ` El anticipo para apartar es de ${pesosEnLetras(i.anticipo)}`;
  texto += `, y la cotización vale hasta el ${fechaEnLetras(c.vigencia)}.`;

  return texto;
}

// ---------------------------------------------------------------------
// Avisos
//
// La advertencia de tarifario de prueba sale SIEMPRE y va aparte, para
// que no se pueda omitir por accidente al configurar el agente.
// Los pendientes internos (qué parámetros falta confirmar con Avándaro)
// no se le dicen a quien llama.
// ---------------------------------------------------------------------
export const AVISO_FIJO =
  "Es una tarifa de referencia con cifras de prueba, y la disponibilidad todavía no está confirmada.";

// Los avisos que salen SIEMPRE ya van en AVISO_FIJO. Repetirlos en la
// nota haría que el agente dijera lo mismo dos veces.
const CONSTANTES = [
  /^TARIFARIO DE PRUEBA/i,
  /^Disponibilidad no verificada/i,
  /^Parámetros pendientes/i,   // pendiente interno nuestro, no del que llama
];

// Cuántas notas aguanta alguien de oído antes de dejar de escuchar.
const MAX_NOTAS = 2;

export function avisosVoz(c) {
  const variables = (c.avisos || []).filter((a) => !CONSTANTES.some((re) => re.test(a)));

  // Lo que cambia el precio va primero. Que falte el paquete de
  // alimentos es lo más grave: la cifra sale baja y quien llama se
  // queda con una expectativa equivocada.
  const peso = (a) =>
    /no se especificó paquete/i.test(a) ? 0 :
    /por debajo del mínimo/i.test(a)    ? 1 :
    /alojan hasta/i.test(a)             ? 2 :
    /espacio exterior/i.test(a)         ? 3 :
    /sugerido automáticamente/i.test(a) ? 4 : 5;

  return variables.sort((x, y) => peso(x) - peso(y)).slice(0, MAX_NOTAS);
}

// ---------------------------------------------------------------------
// La respuesta completa, plana a propósito
//
// Aircall mapea la respuesta con expresiones JSONPath. Entre menos
// anidamiento, menos que configurar a mano en su panel y menos que se
// rompa cuando alguien cambie el motor.
// ---------------------------------------------------------------------
export function respuestaVoz(c) {
  const otros = avisosVoz(c);
  return {
    ok: true,
    folio: c.folio,
    espacio: c.espacio.nombre,
    total: pesosEnLetras(c.importes.total),
    total_cifra: c.importes.total,
    anticipo: pesosEnLetras(c.importes.anticipo),
    vigencia: fechaEnLetras(c.vigencia),
    resumen: resumenVoz(c),
    aviso: AVISO_FIJO,
    nota: otros.length ? otros.join(" ") : "",
    folio_deletreado: String(c.folio).split("").join(" "),
  };
}
