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
  const [parametros, temporadas, espacios, tarifas, paquetes, hospedaje, reglas] =
    await Promise.all([
      db.consultar("parametros?select=*"),
      db.consultar("temporadas?select=*"),
      db.consultar("espacios?select=*&activo=eq.true&order=cap_coctel.desc.nullslast"),
      db.consultar("tarifas_espacio?select=*"),
      db.consultar("paquetes_ayb?select=*&activo=eq.true"),
      db.consultar("tarifas_hospedaje?select=*"),
      db.consultar("reglas_descuento?select=*&activo=eq.true"),
    ]);
  cache = {
    parametros: Object.fromEntries(parametros.map((p) => [p.clave, Number(p.valor)])),
    sinConfirmar: parametros.filter((p) => !p.confirmado).map((p) => p.clave),
    temporadas, espacios, tarifas, paquetes, hospedaje, reglas,
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
  const tar = c.tarifas.find((t) =>
    t.espacio === espacio.clave && t.temporada === temporada.nombre && t.tipo_dia === dia);
  if (!tar) {
    errores.push(`No hay tarifa cargada para ${espacio.nombre} en temporada ${temporada.nombre}, día de ${dia}.`);
    return { ok: false, errores };
  }
  const renta = redondea(Number(tar.tarifa_dia) * dias);

  // --- Alimentos y bebidas
  let paquete = null;
  let ayb = 0;
  if (p.paquete_ayb) {
    paquete = c.paquetes.find((q) => q.clave === String(p.paquete_ayb).toUpperCase());
    if (!paquete) errores.push(`El paquete ${p.paquete_ayb} no existe.`);
    else ayb = redondea(Number(paquete.precio_persona) * personas * dias);
  } else {
    avisos.push("No se especificó paquete de alimentos; la cotización va sin consumo.");
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
  if (Number(tar.consumo_minimo) > 0 && baseAyb < Number(tar.consumo_minimo)) {
    avisos.push(`El consumo de alimentos (${dinero(baseAyb)}) queda por debajo del mínimo de ${dinero(tar.consumo_minimo)} que pide ${espacio.nombre}. Comercial tendría que autorizarlo o subir el paquete.`);
  }

  // --- Impuestos. Las tasas vienen de cot.parametros y NO están
  //     confirmadas con el área fiscal de Avándaro.
  const servicio = redondea(baseAyb * (c.parametros.servicio ?? 0));
  const subtotal = redondea(baseEspacio + baseAyb + servicio + baseHosp);
  const iva = redondea(subtotal * (c.parametros.iva ?? 0));
  const ish = redondea(baseHosp * (c.parametros.ish ?? 0));
  const total = redondea(subtotal + iva + ish);

  const vigencia = new Date(Date.now() + (c.parametros.vigencia_dias ?? 15) * 86400000);

  const desglose = [
    { concepto: "Renta de espacio", detalle: `${espacio.nombre}, ${dias} día(s), temporada ${temporada.nombre}, día de ${dia}`,
      cantidad: dias, unitario: Number(tar.tarifa_dia), importe: renta },
  ];
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

  // El aviso ya no es parejo: el hospedaje dejó de ser inventado. Decir
  // que todo es de prueba cuando una parte ya es real le quita peso al
  // aviso, y es justamente el aviso que no queremos que nadie ignore.
  avisos.unshift(
    hospedaje > 0
      ? "Las tarifas de hospedaje son las que publica el hotel. Las de espacios y alimentos todavía son de prueba y no sirven para cotizar a un cliente."
      : "TARIFARIO DE PRUEBA: las cifras de espacios y alimentos son ficticias y no sirven para cotizar a un cliente.");
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
    descuentos,
    importes: {
      renta_espacio: renta, alimentos: ayb, hospedaje,
      descuento_total: redondea(dEspacio + dAyb + dHosp),
      cargo_servicio: servicio, subtotal, iva, ish, total,
      anticipo: redondea(total * (c.parametros.anticipo_pct ?? 0.5)),
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
        paquetes: c.paquetes.map(({ clave, nombre, precio_persona, incluye }) =>
          ({ clave, nombre, precio_persona, incluye })),
        habitaciones: [...new Set(c.hospedaje.map((h) => h.tipo_habitacion))],
        aviso: "Tarifario de prueba. Las cifras son ficticias.",
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
      paquete_ayb: resolverClave(cuerpo.paquete_ayb ?? cuerpo.alimentos, c.paquetes, "clave"),
      tipo_habitacion: resolverClave(cuerpo.tipo_habitacion, c.hospedaje, "tipo_habitacion"),
      montaje: cuerpo.montaje || undefined,
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
