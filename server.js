// =====================================================================
// Servicio de agentes · Grupo Avándaro × Freelan
//
// Un solo servicio en Railway que monta los dos bancos de prueba:
//
//   Cotizador  POST /cotizar/<COTIZADOR_TOKEN>    esquema cot
//              GET  /espacios/<COTIZADOR_TOKEN>
//
//   Concierge  POST /mcp/<MCP_TOKEN>              esquema demo
//
// Cada módulo se monta SOLO si su token está configurado. Así se puede
// desplegar hoy con el Cotizador y agregar el Concierge mañana sin
// tocar código: se añade la variable y se reinicia.
//
// Un servicio en vez de dos significa un despliegue, un dominio y un
// juego de secretos que rotar.
// =====================================================================

import express from "express";
import { crearCliente } from "./nube.js";
import * as cotizador from "./cotizador.js";
import * as concierge from "./concierge.js";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  COTIZADOR_TOKEN,
  MCP_TOKEN,
  PORT = 3000,
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) {
    console.error(`Falta la variable de entorno ${k}`);
    process.exit(1);
  }
}

if (!COTIZADOR_TOKEN && !MCP_TOKEN) {
  console.error("No hay ningún módulo configurado: falta COTIZADOR_TOKEN o MCP_TOKEN");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "256kb" }));

const montados = [];
const modulos = {};

if (COTIZADOR_TOKEN) {
  const cliente = crearCliente(SUPABASE_URL, SUPABASE_SERVICE_KEY, "cot");
  modulos.cotizador = cliente;
  montados.push(...cotizador.montar(app, { cliente, token: COTIZADOR_TOKEN }));
} else {
  console.log("Cotizador no montado: falta COTIZADOR_TOKEN");
}

if (MCP_TOKEN) {
  const cliente = crearCliente(SUPABASE_URL, SUPABASE_SERVICE_KEY, "demo");
  modulos.concierge = cliente;
  montados.push(...concierge.montar(app, { cliente, token: MCP_TOKEN }));
} else {
  console.log("Concierge no montado: falta MCP_TOKEN");
}

app.get("/", (_q, r) => r.json({
  ok: true,
  servicio: "avandaro-agentes",
  modulos: Object.keys(modulos),
  rutas: montados,
}));

app.get("/health", (_q, r) => r.json({ ok: true }));

// Diagnóstico: dice si cada esquema está realmente alcanzable. Vale más
// que un /health que solo confirma que el proceso vive.
app.get("/diagnostico", async (_q, r) => {
  const salida = { servicio: "avandaro-agentes", modulos: {} };
  if (modulos.cotizador) salida.modulos.cotizador = {
    esquema: "cot", ...(await modulos.cotizador.verificar("espacios")) };
  if (modulos.concierge) salida.modulos.concierge = {
    esquema: "demo", ...(await modulos.concierge.verificar("socios")) };
  const todoBien = Object.values(salida.modulos).every((m) => m.ok);
  r.status(todoBien ? 200 : 503).json(salida);
});

app.listen(PORT, () => {
  console.log(`Servicio de agentes escuchando en el puerto ${PORT}`);
  for (const ruta of montados) console.log(`  ${ruta}`);
  console.log("  GET /diagnostico  ← comprueba que los esquemas respondan");
});
