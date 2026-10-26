// =====================================================================
// Acción codificada para un workflow de HubSpot
// Cotizador Inteligente · Grupo Avándaro × Freelan
//
// Va en: Workflows → acción "Custom code" → Node.js 20.
//
// Este es el camino que NO depende del marketplace de conectores de
// HubSpot ni del permiso de crear agentes Breeze. Prueba justo lo que
// estaba en duda: que HubSpot pueda consumir lógica y datos que viven
// fuera y escribir el resultado de vuelta en el negocio.
//
// SECRETOS que hay que dar de alta en la acción (botón "Secrets"):
//   COTIZADOR_URL    https://<tu-servicio>.up.railway.app
//   COTIZADOR_TOKEN  el mismo valor que en Railway
//
// CAMPOS DE ENTRADA a mapear desde propiedades del negocio:
//   fecha_evento, num_personas, num_dias, num_habitaciones,
//   num_noches, espacio, paquete_ayb, tipo_habitacion, montaje
// Solo fecha_evento y num_personas son obligatorios; el resto es
// opcional y el motor rellena o sugiere.
// =====================================================================

exports.main = async (event, callback) => {
  const campo = (nombre) => {
    const v = event.inputFields?.[nombre];
    return v === undefined || v === null || v === "" ? undefined : v;
  };

  const peticion = {
    origen: "hubspot-workflow",
    deal_id: String(event.object?.objectId ?? campo("hs_object_id") ?? ""),
    fecha_inicio: campo("fecha_evento"),
    personas: campo("num_personas"),
    dias: campo("num_dias") ?? 1,
    habitaciones: campo("num_habitaciones") ?? 0,
    noches: campo("num_noches") ?? 0,
    espacio: campo("espacio"),
    paquete_ayb: campo("paquete_ayb"),
    tipo_habitacion: campo("tipo_habitacion"),
    montaje: campo("montaje"),
  };

  // HubSpot entrega las fechas como milisegundos desde época. El
  // endpoint espera AAAA-MM-DD.
  if (typeof peticion.fecha_inicio === "number" || /^\d{10,}$/.test(String(peticion.fecha_inicio))) {
    peticion.fecha_inicio = new Date(Number(peticion.fecha_inicio)).toISOString().slice(0, 10);
  }

  const base = (process.env.COTIZADOR_URL || "").replace(/\/+$/, "");
  const url = `${base}/cotizar/${process.env.COTIZADOR_TOKEN}`;

  let r, datos;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(peticion),
    });
    datos = await r.json();
  } catch (e) {
    return callback({
      outputFields: {
        cotizacion_ok: "false",
        cotizacion_error: `No se pudo contactar al cotizador: ${e.message}`,
      },
    });
  }

  if (!datos.ok) {
    return callback({
      outputFields: {
        cotizacion_ok: "false",
        cotizacion_error: (datos.errores || ["Error desconocido"]).join(" · "),
      },
    });
  }

  const pesos = (n) =>
    new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(n);

  // HubSpot solo guarda valores simples en propiedades, así que el
  // desglose se arma como texto para una propiedad multilínea.
  const lineas = [
    `Folio ${datos.folio}`,
    `${datos.espacio.nombre} · temporada ${datos.temporada} · día de ${datos.tipo_dia}`,
    `${datos.evento.personas} personas · ${datos.evento.dias} día(s)` +
      (datos.evento.habitaciones ? ` · ${datos.evento.habitaciones} habitaciones × ${datos.evento.noches} noche(s)` : ""),
    "",
    ...datos.desglose.map((d) => `${d.concepto}: ${pesos(d.importe)}  (${d.detalle})`),
  ];

  if (datos.descuentos.length) {
    lineas.push("", "Descuentos aplicados:");
    lineas.push(...datos.descuentos.map((d) => `  ${d.descripcion}: -${pesos(d.importe)}`));
  }

  lineas.push(
    "",
    `Subtotal: ${pesos(datos.importes.subtotal)}`,
    `IVA: ${pesos(datos.importes.iva)}`,
    ...(datos.importes.ish ? [`Impuesto sobre hospedaje: ${pesos(datos.importes.ish)}`] : []),
    `TOTAL: ${pesos(datos.importes.total)}`,
    `Anticipo sugerido: ${pesos(datos.importes.anticipo)}`,
    `Vigencia: ${datos.vigencia}`,
    "",
    ...datos.avisos.map((a) => `· ${a}`),
  );

  callback({
    outputFields: {
      cotizacion_ok: "true",
      cotizacion_folio: datos.folio,
      cotizacion_total: datos.importes.total,
      cotizacion_subtotal: datos.importes.subtotal,
      cotizacion_descuento: datos.importes.descuento_total,
      cotizacion_anticipo: datos.importes.anticipo,
      cotizacion_espacio: datos.espacio.nombre,
      cotizacion_temporada: datos.temporada,
      cotizacion_vigencia: datos.vigencia,
      cotizacion_desglose: lineas.join("\n"),
      cotizacion_error: "",
    },
  });
};
