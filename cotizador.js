// =====================================================================
// Cotizador Inteligente · motor y rutas
//
// Se monta dentro del servicio compartido. El esquema de Supabase que
// usa es "cot".
//
// *** EL TARIFARIO ES FICTICIO. *** El real vive en un Google Sheet del
// equipo comercial que todavía no hemos visto. Toda respuesta sale
// marcada con esa advertencia a propósito.
// =====================================================================

import { randomUUID } from "node:crypto";
import { respuestaVoz, aFechaISO, aNumero, resolverClave, AVISO_FIJO } from "./voz.js";

let db = null;

// ---------------------------------------------------------------------
// Catálogos en memoria. Son decenas de filas y cambian cuando alguien
// edita el tarifario, no en cada petición.
// ---------------------------------------------------------------------
let cache = null;
let cacheHasta = 0;

async function catalogos() {
  if (cache && Date.now() < cacheHasta) return cache;
  const [parametros, temporadas, espacios, tarifas, paquetes, hospedaje, reglas,
         experiencias, alimentos, salones] =
    await Promise.all([
      db.consultar("parametros?select=*"),
      db.consultar("temporadas?select=*"),
      db.consultar("espacios?select=*&activo=eq.true&order=cap_coctel.desc.nullslast"),
      db.consultar("tarifas_espacio?select=*"),
      db.consultar("paquetes_ayb?select=*&activo=eq.true"),
      db.consultar("tarifas_hospedaje?select=*"),
      db.consultar("reglas_descuento?select=*&activo=eq.true"),
      // Las tres últimas pueden no existir todavía: el cotizador
      // funcionaba antes de que cargáramos el tarifario real.
      db.consultar("experiencias?select=*&activo=eq.true").catch(() => []),
      db.consultar("alimentos?select=*&activo=eq.true").catch(() => []),
      db.consultar("salones?select=*&activo=eq.true").catch(() => []),
    ]);
  cache = {
    parametros: Object.fromEntries(parametros.map((p) => [p.clave, Number(p.valor)])),
    sinConfirmar: parametros.filter((p) => !p.confirmado).map((p) => p.clave),
    temporadas, espacios, tarifas, paquetes, hospedaje, reglas, experiencias,
    alimentos, salones,
  };
  cacheHasta = Date.now() + 5 * 60 * 1000;
  return cache;
}

// ---------------------------------------------------------------------
// Temporada y tipo de día
// ---------------------------------------------------------------------
function temporadaDe(fecha, temporadas) {
  const mes = fecha.getUTCMonth() + 1;
  const dia = fecha.getUTCDate();
  const dentro = (t) => {
    const desde = t.desde_mes * 100 + t.desde_dia;
    const hasta = t.hasta_mes * 100 + t.hasta_dia;
    const hoy = mes * 100 + dia;
    // Un rango que cruza el fin de año se parte en dos comparaciones.
    return desde <= hasta ? hoy >= desde && hoy <= hasta : hoy >= desde || hoy <= hasta;
  };
  const orden = { alta: 0, media: 1, baja: 2 };
  const halladas = temporadas.filter(dentro).sort((a, b) => orden[a.nombre] - orden[b.nombre]);
  return halladas.length ? halladas[0] : { nombre: "media", nota: "sin rango definido" };
}

// Viernes, sábado y domingo cuentan como fin de semana para eventos.
// Es un criterio nuestro y hay que confirmarlo con comercial.
function tipoDia(fecha) {
  const d = fecha.getUTCDay();
  return d === 5 || d === 6 || d === 0 ? "fin" : "semana";
}

// ---------------------------------------------------------------------
// Reglas de descuento. Dentro de un mismo concepto gana la de mayor
// beneficio; no se acumulan. Entre conceptos distintos sí aplican a la
// vez, porque golpean bases distintas.
// ---------------------------------------------------------------------
const CUMPLE = {
  ">=": (a, b) => a >= b, ">": (a, b) => a > b, "=": (a, b) => a === b,
  "<=": (a, b) => a <= b, "<": (a, b) => a < b,
};

function mejorRegla(reglas, concepto, datos, temporada) {
  const aplicables = reglas.filter((r) =>
    r.aplica_a === concepto &&
    (!r.temporada || r.temporada === temporada) &&
    CUMPLE[r.operador](Number(datos[r.campo] ?? 0), Number(r.valor)));
  if (!aplicables.length) return null;
  return aplicables.reduce((a, b) => (Number(b.porcentaje) > Number(a.porcentaje) ? b : a));
}

const redondea = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dinero = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

// ---------------------------------------------------------------------
// Precio de una actividad
//
// Esto replica la función con la que el propio cotizador del hotel cobra
// las actividades. Hay dos formas y no son intercambiables:
//
//   por_persona   el precio se multiplica por los asistentes
//   por_tramo     el monto del tramo se cobra PLANO, sin multiplicar
//
// Lo segundo se ve raro hasta que se ven las cifras: el circuito de
// energía cuesta 82,399.99 para un grupo de 51 a 60 personas, no 82,399.99
// por cada una. Se confirmó contra una cotización real del hotel, folio
// AVA-2026-10290754: el coaching ejecutivo para 12 personas salió en
// 2,100, que es exactamente el monto del tramo de 11 a 19.
//
// Si el grupo se sale de todos los tramos se usa el último, igual que
// hace su código. El aforo se avisa aparte, antes de llegar aquí.
// ---------------------------------------------------------------------
function precioActividad(e, personas) {
  const tramos = Array.isArray(e.tramos) ? e.tramos : null;
  if (tramos && tramos.length) {
    const t = tramos.find((x) =>
      personas >= Number(x.desde) && personas <= Number(x.hasta));
    return Number((t ?? tramos[tramos.length - 1]).monto);
  }
  return Number(e.precio_persona ?? 0) * personas;
}

// El catálogo guarda las horas como número; antes venían como texto
// ("3 horas"). Se aceptan las dos para no depender del orden de carga.
function duracionTexto(e) {
  if (e.duracion) return String(e.duracion);
  const h = Number(e.duracion_horas);
  if (!h) return null;
  return h === 1 ? "1 hora" : `${h} horas`;
}

// =====================================================================
// Motor
// =====================================================================
async function cotizar(p) {
  const c = await catalogos();
  const avisos = [];
  const errores = [];

  // --- Validación de entrada
  const fecha = new Date(`${p.fecha_inicio}T12:00:00Z`);
  if (Number.isNaN(fecha.getTime())) errores.push("fecha_inicio no es una fecha válida (AAAA-MM-DD).");

  const personas = Math.max(0, parseInt(p.personas ?? 0, 10) || 0);
  const dias = Math.max(1, parseInt(p.dias ?? 1, 10) || 1);
  const habitaciones = Math.max(0, parseInt(p.habitaciones ?? 0, 10) || 0);
  const noches = Math.max(0, parseInt(p.noches ?? 0, 10) || 0);

  if (!personas) errores.push("Falta el número de personas.");
  if (habitaciones > 0 && noches === 0) {
    avisos.push("Se pidieron habitaciones sin noches; se asume una noche por día de evento.");
  }
  const nochesReales = habitaciones > 0 && noches === 0 ? dias : noches;

  if (errores.length) return { ok: false, errores };

  const temporada = temporadaDe(fecha, c.temporadas);
  const dia = tipoDia(fecha);

  // --- Espacio
  let espacio = null;
  if (p.espacio) {
    espacio = c.espacios.find((e) => e.clave === String(p.espacio).toUpperCase());
    if (!espacio) errores.push(`El espacio ${p.espacio} no existe en el catálogo.`);
  } else {
    // El más chico donde quepa la gente, que es como cotizaría una
    // persona: no se ofrece el salón grande si cabe en el mediano.
    const montaje = (p.montaje || "banquete").toLowerCase();
    const campo = { auditorio: "cap_auditorio", banquete: "cap_banquete",
                    coctel: "cap_coctel", escuela: "cap_escuela" }[montaje] || "cap_banquete";
    const caben = c.espacios
      .filter((e) => e[campo] && e[campo] >= personas)
      .sort((a, b) => a[campo] - b[campo]);
    if (!caben.length) {
      errores.push(`Ningún espacio del catálogo acomoda ${personas} personas en montaje ${montaje}.`);
    } else {
      espacio = caben[0];
      avisos.push(`Espacio sugerido automáticamente: el más pequeño donde caben ${personas} personas en montaje ${montaje}.`);
    }
  }
  if (errores.length) return { ok: false, errores };

  // Capacidad contra el montaje pedido
  const capacidades = [espacio.cap_auditorio, espacio.cap_banquete, espacio.cap_coctel, espacio.cap_escuela]
    .filter((x) => x != null);
  const capMax = capacidades.length ? Math.max(...capacidades) : 0;
  if (capMax && personas > capMax) {
    errores.push(`${espacio.nombre} acomoda ${capMax} personas como máximo y se pidieron ${personas}.`);
    return { ok: false, errores };
  }

  if (!espacio.interior) {
    avisos.push(`${espacio.nombre} es un espacio exterior. Conviene cotizar un plan alterno techado, sobre todo entre junio y septiembre.`);
  }

  // --- Renta del espacio
  //
  // El hotel no cobra por salón: cobra por bloques de 25 personas, al
  // mismo precio en cualquiera de sus sedes, por cada día con sesión.
  // Un grupo de 80 son cuatro bloques, quepan donde quepan.
  //
  // La tarifa por salón y temporada que teníamos antes era inventada.
  // La fila de cot.tarifas_espacio se sigue buscando, pero solo por el
  // consumo mínimo, y ya no es obligatoria: antes su ausencia tumbaba
  // la cotización completa.
  const tar = c.tarifas.find((t) =>
    t.espacio === espacio.clave && t.temporada === temporada.nombre && t.tipo_dia === dia) ?? null;

  const tamBloque = c.parametros.salon_bloque_personas ?? 25;
  const precioBloque = c.parametros.salon_bloque_precio ?? 0;
  const bloques = Math.ceil(personas / tamBloque);
  const renta = redondea(bloques * precioBloque * dias);

  if (!precioBloque) {
    avisos.push("No está cargado el precio de bloque de salón; la cotización va sin renta de espacio.");
  }

  // --- Alimentos y bebidas
  // Dos caminos, y el real gana.
  //
  //   p.alimentos    lista contra cot.alimentos, el catálogo del hotel
  //   p.paquete_ayb  los paquetes que nos habíamos inventado
  //
  // Los paquetes siguen ahí porque el workflow de HubSpot ya manda ese
  // campo y quitarlo lo rompería. Pero sus cifras son de prueba, y el
  // aviso del final lo dice.
  let paquete = null;
  let ayb = 0;
  const comidas = [];
  const comidasNoHalladas = [];
  const comidasBajoMinimo = [];

  const pedidasAyb = []
    .concat(p.alimentos ?? [])
    .flatMap((x) => String(x).split(/\s*[,;]\s*|\s+y\s+/))
    .map((x) => x.trim()).filter(Boolean);

  for (const texto of pedidasAyb) {
    const clave = resolverClave(texto, c.alimentos ?? [], "clave");
    const a = (c.alimentos ?? []).find((x) => x.clave === clave);
    if (!a) { comidasNoHalladas.push(texto); continue; }
    if (a.minimo_personas && personas < Number(a.minimo_personas)) {
      comidasBajoMinimo.push(a); continue;
    }
    // Las barras se cobran por persona POR HORA; el resto por persona.
    const horas = a.por_hora ? Number(a.duracion_horas || 1) : 1;
    const importe = redondea(Number(a.precio_persona) * personas * horas * dias);
    comidas.push({
      clave: a.clave, nombre: a.nombre, subgrupo: a.subgrupo ?? null,
      precio_persona: Number(a.precio_persona), por_hora: !!a.por_hora,
      horas: a.por_hora ? horas : null, importe,
    });
  }

  if (comidas.length) {
    ayb = redondea(comidas.reduce((s, x) => s + x.importe, 0));
  } else if (p.paquete_ayb) {
    paquete = c.paquetes.find((q) => q.clave === String(p.paquete_ayb).toUpperCase());
    if (!paquete) errores.push(`El paquete ${p.paquete_ayb} no existe.`);
    else ayb = redondea(Number(paquete.precio_persona) * personas * dias);
  }

  if (!ayb && !pedidasAyb.length && !p.paquete_ayb) {
    avisos.push("No se especificó paquete de alimentos; la cotización va sin consumo.");
  }
  for (const a of comidasBajoMinimo) {
    avisos.push(`${a.nombre} pide un mínimo de ${a.minimo_personas} personas y el grupo es de ${personas}; queda fuera de la cotización.`);
  }
  if (comidasNoHalladas.length) {
    avisos.push(`No encontré en el catálogo de alimentos: ${comidasNoHalladas.join(", ")}.`);
  }
  if (errores.length) return { ok: false, errores };

  // --- Hospedaje
  let hab = null;
  let hospedaje = 0;
  let nochesCobradas = [];
  if (habitaciones > 0) {
    const tipo = String(p.tipo_habitacion || "HAB-DOBLE").toUpperCase();

    // Noche por noche, no todas al tipo de día del inicio.
    //
    // Con el tarifario real la diferencia entre semana y fin de semana
    // va de 7% en la doble a 79% en la presidencial. Una estancia de
    // jueves a sábado cobrada toda como "entre semana" sale mal por
    // miles de pesos, y el cliente lo nota al comparar con su factura.
    for (let i = 0; i < nochesReales; i++) {
      const esa = new Date(fecha.getTime() + i * 86400000);
      const td = tipoDia(esa);
      const tarifa = c.hospedaje.find((h) => h.tipo_habitacion === tipo && h.tipo_dia === td);
      if (!tarifa) {
        errores.push(`No hay tarifa de ${tipo} para ${td === "fin" ? "fin de semana" : "entre semana"}.`);
        nochesCobradas = [];
        break;
      }
      nochesCobradas.push({ fecha: esa.toISOString().slice(0, 10), tipo_dia: td,
                    tarifa: Number(tarifa.tarifa_noche) });
      hab = tarifa;
    }

    if (nochesCobradas.length) {
      hospedaje = redondea(nochesCobradas.reduce((s, n) => s + n.tarifa, 0) * habitaciones);

      // "habitaciones tipo habitación doble" es redundante.
      const tipoCorto = hab.nombre.toLowerCase().replace(/^habitaci[oó]n\s+/, "");
      const cupo = hab.ocupacion_max * habitaciones;
      if (personas > cupo) {
        avisos.push(`Las ${habitaciones} habitaciones tipo ${tipoCorto} alojan hasta ${cupo} personas y el evento es de ${personas}. Habría que ajustar el bloque.`);
      }

      // El inventario no es disponibilidad, pero sí es un techo. Pedir
      // más habitaciones de las que existen no depende de Opera.
      if (hab.inventario && habitaciones > hab.inventario) {
        avisos.push(`El hotel tiene ${hab.inventario} habitaciones tipo ${tipoCorto} y se están pidiendo ${habitaciones}.`);
      }

      if (new Set(nochesCobradas.map((n) => n.tipo_dia)).size > 1) {
        avisos.push("La estancia cruza entre semana y fin de semana; cada noche se cobra a su propia tarifa.");
      }
    }
  }
  if (errores.length) return { ok: false, errores };

  // --- Descuentos
  const datos = { habitaciones, personas, dias, noches: nochesReales };
  const descuentos = [];
  const aplica = (concepto, base) => {
    if (base <= 0) return 0;
    const r = mejorRegla(c.reglas, concepto, datos, temporada.nombre);
    if (!r) return 0;
    const importe = redondea(base * Number(r.porcentaje));
    descuentos.push({
      regla: r.clave,
      descripcion: r.descripcion,
      concepto,
      porcentaje: Number(r.porcentaje),
      importe,
    });
    return importe;
  };

  const dEspacio = aplica("espacio", renta);
  const dAyb = aplica("ayb", ayb);
  const dHosp = aplica("hospedaje", hospedaje);

  const baseEspacio = redondea(renta - dEspacio);
  const baseAyb = redondea(ayb - dAyb);
  const baseHosp = redondea(hospedaje - dHosp);

  // --- Consumo mínimo del espacio
  if (tar && Number(tar.consumo_minimo) > 0 && baseAyb < Number(tar.consumo_minimo)) {
    avisos.push(`El consumo de alimentos (${dinero(baseAyb)}) queda por debajo del mínimo de ${dinero(tar.consumo_minimo)} que pide ${espacio.nombre}. Comercial tendría que autorizarlo o subir el paquete.`);
  }

  // --- Impuestos.
  //
  // No van sobre todo el subtotal. Cada concepto lleva lo suyo, y así es
  // como lo cobra el hotel en su propio cotizador:
  //
  //   hospedaje     IVA 16% + ISH 4%            factor 1.20
  //   alimentos     IVA 16% + 15% de servicio   factor 1.31
  //   espacios      nada
  //   actividades   nada
  //
  // Los dos factores salen de su código y son aditivos, no compuestos:
  // el servicio no causa IVA. Que espacios y actividades no lleven
  // impuesto es decisión de ellos, no nuestra, y quedó por escrito en
  // sql/tarifario_real.sql para preguntárselo.
  const servicio = redondea(baseAyb * (c.parametros.servicio ?? 0));
  const subtotal = redondea(baseEspacio + baseAyb + servicio + baseHosp);
  const iva = redondea((baseAyb + baseHosp) * (c.parametros.iva ?? 0));
  const ish = redondea(baseHosp * (c.parametros.ish ?? 0));

  // --- Propinas. Van por habitación, no por persona, y se suman DESPUÉS
  //     de impuestos: así las cobra el hotel en su propia cotización.
  //     Las camaristas por noche; los bellboys una vez por estancia.
  const propinas = habitaciones > 0
    ? redondea(habitaciones * nochesReales * (c.parametros.propina_camarista ?? 0) +
               habitaciones * (c.parametros.propina_bellboy ?? 0))
    : 0;

  // --- Experiencias.
  //
  // Se suman después de impuestos, igual que las presenta el hotel en su
  // propia cotización: ahí las actividades aparecen como un importe
  // cerrado que se agrega al total de hospedaje ya con IVA.
  //
  // Las que el hotel marcó para cotizar con su área NO se cobran ni se
  // estiman: se nombran en un aviso. Las fogatas son el ejemplo de por
  // qué: el propio hotel dejó por escrito que no sabe si los 500 son
  // por fogata o por persona, y con 80 asistentes esa duda vale casi
  // cuarenta mil pesos.
  const pedidas = []
    .concat(p.experiencias ?? [])
    .flatMap((x) => String(x).split(/\s*[,;]\s*|\s+y\s+/))
    .map((x) => x.trim()).filter(Boolean);

  const experiencias = [];
  const porCotizar = [];
  const noHalladas = [];
  const fueraDeAforo = [];
  const porConfirmar = [];

  for (const texto of pedidas) {
    const clave = resolverClave(texto, c.experiencias ?? [], "clave");
    const e = (c.experiencias ?? []).find((x) => x.clave === clave);
    if (!e) { noHalladas.push(texto); continue; }
    if (e.cotizar_aparte) { porCotizar.push(e); continue; }

    // El tope del último tramo es el aforo de la actividad. Mejor decirlo
    // antes de cotizar que mandar un número que el hotel no puede cumplir.
    if (e.maximo_personas && personas > Number(e.maximo_personas)) {
      fueraDeAforo.push(e); continue;
    }

    const importe = redondea(precioActividad(e, personas));
    if (e.nota) porConfirmar.push(e);
    experiencias.push({
      clave: e.clave, nombre: e.nombre,
      duracion: duracionTexto(e),
      modo_cobro: e.modo_cobro ?? "por_persona",
      precio_persona: e.modo_cobro === "por_tramo" ? null : Number(e.precio_persona ?? 0),
      importe,
    });
  }

  const totalExperiencias = redondea(experiencias.reduce((s, e) => s + e.importe, 0));

  for (const e of porCotizar) {
    avisos.push(
      `${e.nombre}${duracionTexto(e) ? ` (${duracionTexto(e)})` : ""} va fuera de esta cotización: ` +
      `el tarifario de actividades todavía no lo tenemos.` +
      (e.nota ? ` ${e.nota}` : ""));
  }
  for (const e of fueraDeAforo) {
    avisos.push(
      `${e.nombre} llega hasta ${e.maximo_personas} personas y el grupo es de ${personas}. ` +
      `Habría que partirlo en grupos o pedirle a Avándaro una cotización especial.`);
  }
  if (noHalladas.length) {
    avisos.push(`No encontré en el catálogo: ${noHalladas.join(", ")}. Habría que confirmarlas con el área de experiencias.`);
  }
  for (const e of porConfirmar) {
    avisos.push(`${e.nombre}: ${e.nota}`);
  }
  if (totalExperiencias > 0) {
    avisos.push("Las actividades van al precio del cotizador del hotel y, como en su cotización, se suman al total sin impuesto adicional.");
  }

  const total = redondea(subtotal + iva + ish + propinas + totalExperiencias);

  const vigencia = new Date(Date.now() + (c.parametros.vigencia_dias ?? 15) * 86400000);

  // El detalle ya no habla de temporada ni de tipo de día, porque la
  // renta dejó de depender de eso: son bloques de 25 personas. Y el
  // unitario sale del precio de bloque, no de tar.tarifa_dia, que puede
  // venir nulo desde que la fila de tarifas_espacio es opcional.
  const desglose = [
    { concepto: "Renta de espacio",
      detalle: `${espacio.nombre}, ${bloques} bloque(s) de ${tamBloque} personas, ${dias} día(s)`,
      cantidad: bloques * dias, unitario: precioBloque, importe: renta },
  ];
  for (const x of comidas) {
    desglose.push({
      concepto: "Alimentos y bebidas",
      // Con una sola partida bastaba el concepto. Con tres salían tres
      // renglones iguales que decían "Alimentos y bebidas" y un monto,
      // sin que el cliente supiera cuál era cuál.
      etiqueta: x.nombre,
      detalle: `${x.nombre}, ${personas} personas` +
        (x.por_hora ? ` × ${x.horas} h` : "") + (dias > 1 ? `, ${dias} día(s)` : ""),
      cantidad: personas * dias * (x.horas ?? 1),
      unitario: x.precio_persona,
      importe: x.importe,
    });
  }
  if (paquete) {
    desglose.push({ concepto: "Alimentos y bebidas", detalle: `${paquete.nombre}, ${personas} personas, ${dias} día(s)`,
      cantidad: personas * dias, unitario: Number(paquete.precio_persona), importe: ayb });
  }
  if (hab) {
    desglose.push({ concepto: "Hospedaje", detalle: `${hab.nombre}, ${habitaciones} habitaciones, ${nochesReales} noche(s)`,
      cantidad: habitaciones * nochesReales,
      unitario: nochesCobradas.length ? redondea(nochesCobradas.reduce((s, n) => s + n.tarifa, 0) / nochesCobradas.length) : 0,
      importe: hospedaje });
  }
  // Las actividades NO van aquí. Van en su propio arreglo, porque se
  // suman después de impuestos y porque quien arma el texto las recorre
  // aparte. Meterlas al desglose las imprimía dos veces en el mensaje
  // que ve el cliente.

  // El aviso ya no es parejo: el hospedaje dejó de ser inventado. Decir
  // que todo es de prueba cuando una parte ya es real le quita peso al
  // aviso, y es justamente el aviso que no queremos que nadie ignore.
  //
  // Ahora son tres niveles, no dos. Hospedaje y actividades salen del
  // cotizador del propio hotel. Espacios y alimentos siguen siendo
  // cifras de prueba hasta que carguemos su tarifario real.
  const reales = [];
  if (hospedaje > 0) reales.push("hospedaje");
  if (renta > 0) reales.push("espacios");
  if (comidas.length) reales.push("alimentos");
  if (totalExperiencias > 0) reales.push("actividades");
  const ficticias = [];
  // Solo queda una cosa inventada: los paquetes de alimentos, que siguen
  // ahí porque el workflow de HubSpot todavía manda paquete_ayb.
  if (paquete) ficticias.push("alimentos");

  // "hospedaje y espacios y alimentos" era lo que salía con un join
  // simple. Tres conceptos piden coma y una sola conjunción.
  const enumera = (xs) => xs.length < 2
    ? (xs[0] ?? "")
    : `${xs.slice(0, -1).join(", ")} y ${xs[xs.length - 1]}`;

  if (!ficticias.length && reales.length) {
    avisos.unshift(
      `Las tarifas de ${enumera(reales)} son las que publica el hotel.`);
  } else if (reales.length) {
    avisos.unshift(
      `Las tarifas de ${enumera(reales)} son las que publica el hotel. ` +
      `Las de ${enumera(ficticias)} todavía son de prueba y no sirven para cotizar a un cliente.`);
  } else if (ficticias.length) {
    avisos.unshift(
      `TARIFARIO DE PRUEBA: las cifras de ${enumera(ficticias)} son ficticias ` +
      `y no sirven para cotizar a un cliente.`);
  }
  avisos.push("Disponibilidad no verificada. El inventario de salones y habitaciones vive en Opera y todavía no está conectado.");
  if (c.sinConfirmar.length) {
    avisos.push(`Parámetros pendientes de confirmar con Avándaro: ${c.sinConfirmar.join(", ")}.`);
  }

  return {
    ok: true,
    folio: `COT-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`,
    temporada: temporada.nombre,
    tipo_dia: dia,
    vigencia: vigencia.toISOString().slice(0, 10),
    espacio: {
      clave: espacio.clave, nombre: espacio.nombre, tipo: espacio.tipo,
      ubicacion: espacio.ubicacion, interior: espacio.interior,
      capacidades: { auditorio: espacio.cap_auditorio, banquete: espacio.cap_banquete,
                     coctel: espacio.cap_coctel, escuela: espacio.cap_escuela },
      notas: espacio.notas,
    },
    evento: { personas, dias, habitaciones, noches: nochesReales,
              paquete: paquete?.nombre ?? null, habitacion: hab?.nombre ?? null },
    desglose,
    // Van aparte del desglose porque se suman después de impuestos.
    experiencias,
    descuentos,
    importes: {
      renta_espacio: renta, alimentos: ayb, hospedaje,
      descuento_total: redondea(dEspacio + dAyb + dHosp),
      cargo_servicio: servicio, subtotal, iva, ish, propinas,
      experiencias: totalExperiencias, total,
      anticipo: redondea(total * (c.parametros.anticipo_pct ?? 0.5)),
      saldo_dias_antes: c.parametros.saldo_dias_antes ?? null,
    },
    total_texto: dinero(total),
    avisos,
  };
}


// =====================================================================
// Rutas
// =====================================================================
export function montar(app, { cliente, token }) {
  db = cliente;

  const autoriza = (req, res, next) =>
    req.params.token === token ? next() : res.status(401).json({ error: "token inválido" });

  // Aircall manda el secreto en la cabecera, no en la ruta. Soporta
  // Bearer, y también una API Key con el nombre de cabecera que uno
  // elija; aceptamos las dos formas para no depender de cómo quede
  // configurado su panel.
  const autorizaCabecera = (req, res, next) => {
    const encabezado = (req.get("authorization") || "").trim();
    const m = /^Bearer\s+(.+)$/i.exec(encabezado);
    const dado = m ? m[1].trim() : (req.get("x-api-key") || "").trim();
    if (dado && dado === token) return next();
    res.set("WWW-Authenticate", "Bearer");
    res.status(401).json({ ok: false, error: "token inválido" });
  };

  // La bitácora es la misma para los tres caminos. Si un agente dice un
  // número que no está en esta tabla, se lo inventó.
  const bitacora = async (peticion, salida, origen) => {
    try {
      await db.insertar("cotizaciones", {
        folio: salida.folio ?? `ERR-${randomUUID().slice(0, 8)}`,
        origen,
        hubspot_deal: peticion.deal_id ?? null,
        peticion,
        respuesta: salida,
        total: salida.importes?.total ?? null,
        error: salida.ok ? null : (salida.errores || []).join(" · "),
      });
    } catch (e) {
      console.error("No se pudo escribir la bitácora:", e.message);
    }
  };

  // Catálogo, para que el workflow o una persona vean qué se puede pedir.
  app.get("/espacios/:token", autoriza, async (_q, r) => {
    try {
      const c = await catalogos();
      r.json({
        espacios: c.espacios.map(({ clave, nombre, tipo, interior, cap_auditorio,
                                    cap_banquete, cap_coctel, cap_escuela, notas }) =>
          ({ clave, nombre, tipo, interior, cap_auditorio, cap_banquete,
             cap_coctel, cap_escuela, notas })),
        salones: (c.salones ?? []).map(({ clave, nombre, capacidad_por_montaje,
                                          capacidad_maxima }) =>
          ({ clave, nombre, capacidad_por_montaje, capacidad_maxima })),
        alimentos: (c.alimentos ?? []).map(({ clave, nombre, subgrupo,
                                              precio_persona, por_hora, minimo_personas }) =>
          ({ clave, nombre, subgrupo, precio_persona, por_hora, minimo_personas })),
        actividades: (c.experiencias ?? []).map(({ clave, nombre, categoria,
                                                   modo_cobro, precio_persona,
                                                   tramos, maximo_personas }) =>
          ({ clave, nombre, categoria, modo_cobro, precio_persona, tramos, maximo_personas })),
        paquetes_de_prueba: c.paquetes.map(({ clave, nombre, precio_persona, incluye }) =>
          ({ clave, nombre, precio_persona, incluye })),
        habitaciones: [...new Set(c.hospedaje.map((h) => h.tipo_habitacion))],
        aviso: "Hospedaje, espacios, alimentos y actividades son del tarifario del hotel. " +
               "Lo único de prueba son los paquetes de alimentos, en paquetes_de_prueba.",
      });
    } catch (e) {
      r.status(500).json({ error: e.message });
    }
  });

  app.post("/cotizar/:token", autoriza, async (req, res) => {
    const peticion = req.body ?? {};
    let salida;
    try {
      salida = await cotizar(peticion);
    } catch (e) {
      console.error("Error al cotizar:", e);
      salida = { ok: false, errores: [`Error interno: ${e.message}`] };
    }

    // Bitácora. Si HubSpot dice que cotizó algo que no está aquí, no pasó.
    try {
      await db.insertar("cotizaciones", {
        folio: salida.folio ?? `ERR-${randomUUID().slice(0, 8)}`,
        origen: peticion.origen ?? "hubspot-workflow",
        hubspot_deal: peticion.deal_id ?? null,
        peticion,
        respuesta: salida,
        total: salida.importes?.total ?? null,
        error: salida.ok ? null : (salida.errores || []).join(" · "),
      });
    } catch (e) {
      console.error("No se pudo escribir la bitácora:", e.message);
    }

    res.status(salida.ok ? 200 : 422).json(salida);
  });

  // -------------------------------------------------------------------
  // Camino de voz, para el AI Voice Agent de Aircall
  //
  // Aircall pide un endpoint HTTPS propio, autenticado por cabecera, y
  // mapea la respuesta con JSONPath. Por eso esta ruta devuelve una
  // estructura plana y en letra, no el desglose completo.
  // -------------------------------------------------------------------

  // Para el botón "Test Connection" del método de autenticación. Solo
  // comprueba credenciales, no ejecuta nada.
  app.get("/voz/ping", autorizaCabecera, (_q, r) =>
    r.json({ ok: true, mensaje: "Autenticación correcta." }));

  app.post("/voz/cotizar", autorizaCabecera, async (req, res) => {
    const cuerpo = req.body ?? {};

    // Lo que recolecta el agente hablando llega como texto, la fecha
    // llega como la haya dicho la persona, y los catálogos llegan en
    // palabras, no en claves.
    let c;
    try {
      c = await catalogos();
    } catch (e) {
      console.error("No se pudo leer el catálogo:", e.message);
      return res.json({
        ok: false, folio: "", total: "", resumen: "", aviso: AVISO_FIJO,
        error: "No puedo consultar el tarifario en este momento.",
      });
    }

    const peticion = {
      origen: "aircall",
      deal_id: cuerpo.deal_id ?? null,
      fecha_inicio: aFechaISO(cuerpo.fecha_inicio ?? cuerpo.fecha_evento),
      personas: aNumero(cuerpo.personas),
      dias: aNumero(cuerpo.dias) ?? 1,
      habitaciones: aNumero(cuerpo.habitaciones) ?? 0,
      noches: aNumero(cuerpo.noches) ?? 0,
      espacio: resolverClave(cuerpo.espacio, c.espacios, "clave"),
      // cuerpo.alimentos ya no cae en paquete_ayb. Antes sí, cuando los
      // paquetes eran lo único que había; ahora es la lista contra el
      // catálogo real y mandarla a paquetes la habría tirado.
      paquete_ayb: resolverClave(cuerpo.paquete_ayb, c.paquetes, "clave"),
      alimentos: cuerpo.alimentos || undefined,
      tipo_habitacion: resolverClave(cuerpo.tipo_habitacion, c.hospedaje, "tipo_habitacion"),
      montaje: cuerpo.montaje || undefined,
      experiencias: cuerpo.experiencias || undefined,
    };

    let salida;
    try {
      salida = await cotizar(peticion);
    } catch (e) {
      console.error("Error al cotizar por voz:", e);
      salida = { ok: false, errores: [`Error interno: ${e.message}`] };
    }

    await bitacora(peticion, salida, "aircall");

    // A propósito se responde 200 aunque la cotización no proceda.
    // Aircall trata cualquier respuesta fuera de 2xx como falla de la
    // acción y el agente se disculpa sin saber por qué. Devolviendo 200
    // con ok en false, el agente puede DECIR qué le faltó y pedirlo.
    if (!salida.ok) {
      return res.json({
        ok: false,
        folio: "",
        total: "",
        resumen: "",
        aviso: AVISO_FIJO,
        error: (salida.errores || ["No se pudo cotizar."]).join(" "),
      });
    }

    res.json(respuestaVoz(salida));
  });

  return [
    "POST /cotizar/:token",
    "GET /espacios/:token",
    "POST /voz/cotizar  (Bearer)",
    "GET /voz/ping  (Bearer)",
  ];
}

// El hilo de WhatsApp necesita el mismo motor y el mismo catálogo. Se
// exportan en vez de duplicarlos, que es justamente lo que haría que un
// canal empezara a dar precios distintos del otro.
//
// Dependen de que cotizador.montar() haya corrido antes, porque ahí se
// inyecta el cliente de Supabase. server.js respeta ese orden.
export { cotizar, catalogos };