import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
import * as A from "../src/auditor.js";
import * as E from "../src/equipo.js";
const { env, dispose } = await getPlatformProxy({ environment: "contenido", persist: false });
for (const stmt of readFileSync("schema.sql", "utf8").split(";").map((s) => s.trim()).filter(Boolean)) await env.HUB_DB.prepare(stmt).run();
const ok = (c, m) => { if (!c) { console.error("FALLA:", m); process.exitCode = 1; } else console.log("ok -", m); };
const guion = "Si anoche dormiste con calor, tu cuerpo no descansó. Las noches de Lima pasan los 22 grados y el cuerpo no logra enfriarse.";
const auditoria = { resumen: "r", puntaje_global: 72, veredicto: "ajustar", criterios: [{ nombre: "Gancho (0–3 s)", puntaje: 7, diagnostico: "d", como_mejorar: "m" }], errores_duros: [], riesgos_retencion: [], ganchos_alternativos: [{ ruta: "shock", texto: "t" }], maslow_lipman: {}, aprendizajes_aplicados: ["nombrar el tema"], version_optimizada: "v" };
let pedido;
const fakeFetch = async (url, init) => { pedido = { url, init, body: JSON.parse(init.body) }; return new Response(JSON.stringify({ content: [{ type: "text", text: "```json\n" + JSON.stringify(auditoria) + "\n```" }] }), { status: 200 }); };

let err; try { await A.auditarGuion({ ...env }, { texto: guion }, fakeFetch); } catch (e) { err = e.message; }
ok(/ANTHROPIC_API_KEY/.test(err), "sin llave: avisa que falta conectarla");
const env2 = { ...env, ANTHROPIC_API_KEY: "test", AUDITOR_TOPE: "2" };
await E.guardarRendimiento(env2, { items: [
  { coleccion: "aprendizajes", id: "tema-primero", datos: { patron: "Nombrar el tema en la primera frase", estado: "Confirmado", veces: 6, cuenta_red: "Dr. Arrieta IG" } },
  { coleccion: "aprendizajes", id: "malo", datos: { patron: "Patrón descartado", estado: "Descartado" } },
] });
err = null; try { await A.auditarGuion(env2, { texto: "corto" }, fakeFetch); } catch (e) { err = e.message; }
ok(/guion completo/.test(err), "rechaza textos demasiado cortos");
const r1 = await A.auditarGuion(env2, { texto: guion, formato: "reel", titulo: "Calor", autor: "Ana" }, fakeFetch);
ok(r1.auditoria.puntaje_global === 72 && r1.usados_mes === 1, "devuelve la auditoría aunque venga envuelta en bloque de código");
ok(pedido.url.includes("api.anthropic.com/v1/messages") && pedido.init.headers["x-api-key"] === "test", "llama a la API oficial con la llave del secreto");
ok(pedido.body.system.includes("Nombrar el tema en la primera frase") && !pedido.body.system.includes("Patrón descartado"), "incluye nuestros aprendizajes vigentes y omite los descartados");
ok(pedido.body.messages[0].content.includes(guion) && pedido.body.messages[0].content.includes("Reel"), "manda el guion y el formato");
await A.auditarGuion(env2, { texto: guion }, fakeFetch);
err = null; try { await A.auditarGuion(env2, { texto: guion }, fakeFetch); } catch (e) { err = e.message; }
ok(/tope/.test(err), "respeta el tope mensual");
const h = await A.historialAuditorias(env2);
ok(h.auditorias.length === 2 && h.auditorias[0].titulo === null && h.auditorias[1].autor === "Ana" && h.conectado, "guarda el historial (lo más nuevo primero)");
const malFetch = async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
err = null; try { await A.auditarGuion({ ...env2, AUDITOR_TOPE: "99" }, { texto: guion }, malFetch); } catch (e) { err = e.message; }
ok(/401/.test(err), "si la API falla, explica el error");

// Rutas del tablero
const { enlace } = await E.enlaceEquipo(env2, {});
const cod = enlace.split("/equipo/")[1];
const call = (p, init) => E.equipoHttp(new Request("https://h" + p, init), env2, new URL("https://h" + p));
ok((await call(`/equipo/${cod}/auditorias`)).status === 200, "historial accesible con el enlace del equipo");
ok((await call(`/equipo/${"c".repeat(32)}/auditar`, { method: "POST", body: "{}" })).status === 404, "con código equivocado no audita");
ok((await call(`/equipo/${cod}/auditar`)).status === 404, "auditar solo por POST");
const rp = await call(`/equipo/${cod}/auditar`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texto: "x" }) });
ok(rp.status === 400 && (await rp.json()).error, "errores del auditor vuelven como JSON legible");
ok((await (await call(`/equipo/${cod}`)).text()).includes("Auditoría de guiones"), "la página muestra la sección de auditoría");
await dispose();
