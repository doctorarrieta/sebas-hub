import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
import * as C from "../src/contenido.js";
import * as P from "../src/publicar.js";
const { env, dispose } = await getPlatformProxy({ environment: "contenido", persist: false });
for (const stmt of readFileSync("schema.sql", "utf8").split(";").map((s) => s.trim()).filter(Boolean)) await env.HUB_DB.prepare(stmt).run();
const ok = (c, m) => { if (!c) { console.error("FALLA:", m); process.exitCode = 1; } else console.log("ok -", m); };
const err = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };

const llamadas = [];
let modo = "ok";
const fakeFetch = async (url, init) => {
  llamadas.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
  if (url.endsWith("/user")) return Response.json({ activeSocialAccounts: ["twitter", "threads", "linkedin"] });
  const b = JSON.parse(init.body);
  if (modo === "falla") return Response.json({ status: "error", errors: [{ code: 156, message: "platform not linked", platform: b.platforms[0] }], postIds: [] }, { status: 400 });
  return Response.json({ status: "success", id: "AYR" + llamadas.length, postIds: [{ status: "success", platform: b.platforms[0], id: "9", postUrl: `https://red/${b.platforms[0]}/9` }] });
};

const { idea } = await C.registrarIdea(env, { fuente: "x", enlace: "https://x.com/a/1", texto: "idea" });
const x = await C.registrarPieza(env, { idea_id: idea.id, formato: "x", texto: "Post corto para X" });
const th = await C.registrarPieza(env, { idea_id: idea.id, formato: "threads", texto: "Post para Threads" });
const li = await C.registrarPieza(env, { idea_id: idea.id, formato: "linkedin", texto: "Post para LinkedIn" });
const largo = await C.registrarPieza(env, { idea_id: idea.id, formato: "x", texto: "a".repeat(281), estado: "aprobada" });
const radio = await C.registrarPieza(env, { idea_id: idea.id, formato: "radio", texto: "guion", estado: "aprobada" });

ok(/aprobada/.test(await err(() => C.actualizarPieza(env, { id: x.id, estado: "programada" }))), "no programa lo que no está aprobado");
ok(/Muy larga/.test(await err(() => C.actualizarPieza(env, { id: largo.id, estado: "programada" }))), "no programa un X de más de 280");
ok((await C.actualizarPieza(env, { id: radio.id, estado: "programada" })).estado === "programada", "radio programada no rompe (no se publica sola)");

for (const p of [x, th, li]) await C.actualizarPieza(env, { id: p.id, estado: "aprobada" });
const futuro = new Date(Date.now() + 3600e3).toISOString();
await C.actualizarPieza(env, { id: x.id, estado: "programada" });                         // ahora
await C.actualizarPieza(env, { id: th.id, estado: "programada" });
await C.actualizarPieza(env, { id: li.id, estado: "programada", programada_para: futuro }); // en una hora

ok((await P.publicarPendientes(env, { fetchImpl: fakeFetch })).omitido, "sin AYRSHARE_API_KEY no hace nada");
env.AYRSHARE_API_KEY = "k"; env.X_API_KEY = "xk"; env.X_API_SECRET = "xs";
await P.pausarPublicacion(env, { pausa: true });
ok((await P.publicarPendientes(env, { fetchImpl: fakeFetch })).omitido === "Publicación en pausa", "freno de emergencia");
await P.pausarPublicacion(env, { pausa: false });

const r = await P.publicarPendientes(env, { fetchImpl: fakeFetch });
ok(r.resultados.length === 2 && r.resultados.every((z) => z.publicada), "publica X y Threads; LinkedIn espera su hora");
const posts = llamadas.filter((l) => l.url.endsWith("/post"));
ok(posts[0].init.headers["X-Twitter-OAuth1-Api-Key"] === "xk" && posts[0].body.platforms[0] === "twitter", "X va con las llaves propias");
ok(!("X-Twitter-OAuth1-Api-Key" in posts[1].init.headers) && posts[1].body.platforms[0] === "threads", "Threads sin llaves de X");
ok(posts[0].body.idempotencyKey === `pieza-${x.id}`, "llave anti-duplicado por pieza");
const px = (await C.listarPiezas(env, { formato: "x", estado: "publicada" }))[0];
ok(px.enlace_publicado === "https://red/twitter/9" && px.fecha_publicacion, "guarda enlace y fecha");
ok((await P.publicarPendientes(env, { fetchImpl: fakeFetch })).resultados.length === 0, "no publica dos veces");

// LinkedIn falla 3 veces → vuelve a aprobada con el error
await env.HUB_DB.prepare("UPDATE piezas SET programada_para = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), li.id).run();
modo = "falla";
for (let i = 0; i < 3; i++) await P.publicarPendientes(env, { fetchImpl: fakeFetch });
const pl = await env.HUB_DB.prepare("SELECT * FROM piezas WHERE id = ?").bind(li.id).first();
ok(pl.estado === "aprobada" && pl.publicar_intentos === 3 && /not linked/.test(pl.comentario), "tras 3 fallas vuelve a aprobada con el error");
const antes = llamadas.length; await P.publicarPendientes(env, { fetchImpl: fakeFetch });
ok(llamadas.length === antes, "no reintenta solo después de devolverla");

// Reprogramar la reinicia; sacarla de cola borra la hora
modo = "ok";
await C.actualizarPieza(env, { id: li.id, estado: "programada" });
await C.actualizarPieza(env, { id: li.id, estado: "aprobada" });
const pl2 = await env.HUB_DB.prepare("SELECT * FROM piezas WHERE id = ?").bind(li.id).first();
ok(pl2.programada_para === null && pl2.publicar_intentos === 0, "sacar de la cola borra la hora y reinicia intentos");
const est = await P.estadoPublicacion(env, fakeFetch);
ok(est.cuentas_conectadas.length === 3 && est.secretos.X_API_KEY, "estado de publicación");
ok(P.largo("x", "mira https://ejemplo.com/una/ruta/muy/larga/de/verdad/que/no/acaba") === 28, "X cuenta enlaces como 23");
await dispose();
