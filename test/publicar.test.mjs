import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
import * as C from "../src/contenido.js";
import * as P from "../src/publicar.js";
const { env, dispose } = await getPlatformProxy({ environment: "contenido", persist: false });
for (const stmt of readFileSync("schema.sql", "utf8").split(";").map((s) => s.trim()).filter(Boolean)) await env.HUB_DB.prepare(stmt).run();
const ok = (c, m) => { if (!c) { console.error("FALLA:", m); process.exitCode = 1; } else console.log("ok -", m); };
const err = async (f) => { try { await f(); return null; } catch (e) { return e.message; } };
const fila = (id) => env.HUB_DB.prepare("SELECT * FROM piezas WHERE id = ?").bind(id).first();

// Firma OAuth 1.0a: vector oficial de la documentación de X
ok(await P.firmaOAuth1({ method: "POST", url: "https://api.twitter.com/1.1/statuses/update.json",
  params: { include_entities: "true", status: "Hello Ladies + Gentlemen, a signed OAuth request!", oauth_consumer_key: "xvz1evFS4wEEPTGEFPHBog", oauth_nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature_method: "HMAC-SHA1", oauth_timestamp: "1318622958", oauth_token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version: "1.0" },
  consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" }) === "hCtSmYh+iHYCEqBWrE7C7hYmtUk=", "firma OAuth 1.0a de X correcta");
ok(P.versionLinkedIn(new Date("2026-10-28")) === "202608", "versión de LinkedIn vigente");
ok(P.escaparLinkedIn("Hola (dato) #1 @x") === "Hola \\(dato\\) \\#1 \\@x", "LinkedIn escapa caracteres reservados");

// Redes falsas
const L = []; let modo = {};
const R = (j, status = 200, headers = {}) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json", ...headers } });
const fake = async (url, init = {}) => {
  url = String(url); L.push({ url, init });
  if (url.startsWith("https://api.x.com/2/tweets")) return modo.x === "429" ? R({ title: "Too Many Requests" }, 429) : R({ data: { id: "111", text: "t" } }, 201);
  if (url.includes("/me/threads_publish")) return modo.th === "500pub" ? R({ error: { message: "boom" } }, 500) : R({ id: "222" });
  if (url.includes("/me/threads")) return R({ id: "C1" });
  if (url.includes("fields=permalink")) return R({ permalink: "https://www.threads.net/@doctorarrieta/post/abc" });
  if (url.startsWith("https://api.linkedin.com/rest/posts")) return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:333" } });
  if (url.includes("/oauth/access_token")) return R({ access_token: "corto", user_id: 77 });
  if (url.includes("th_exchange_token")) return R({ access_token: "largo", expires_in: 5184000 });
  if (url.includes("refresh_access_token")) return R({ access_token: "renovado", expires_in: 5184000 });
  if (url.includes("linkedin.com/oauth/v2/accessToken")) return R({ access_token: "LI", expires_in: 5184000 });
  if (url.includes("/v2/userinfo")) return R({ sub: "abc123", name: "Sebastián Arrieta" });
  return R({}, 404);
};

const { idea } = await C.registrarIdea(env, { fuente: "x", enlace: "https://x.com/a/1", texto: "idea" });
const mk = (formato, texto, estado) => C.registrarPieza(env, { idea_id: idea.id, formato, texto, estado });
const x = await mk("x", "Post corto para X"), th = await mk("threads", "Post para Threads", "aprobada"), li = await mk("linkedin", "Post (LinkedIn) #salud", "aprobada");
const largo = await mk("x", "a".repeat(281), "aprobada");

ok(/aprobada/.test(await err(() => C.actualizarPieza(env, { id: x.id, estado: "programada" }))), "no programa lo que no está aprobado");
ok(/Muy larga/.test(await err(() => C.actualizarPieza(env, { id: largo.id, estado: "programada" }))), "no programa un X de más de 280");
await C.actualizarPieza(env, { id: x.id, estado: "aprobada" });

// Conectar Threads y LinkedIn con enlace de un solo uso
env.THREADS_APP_ID = "app"; env.THREADS_APP_SECRET = "sec"; env.LINKEDIN_CLIENT_ID = "lid"; env.LINKEDIN_CLIENT_SECRET = "lsec";
const eTh = await P.enlaceConexion(env, { red: "threads" });
const st = new URL(eTh.enlace).searchParams.get("state");
ok(new URL(eTh.enlace).searchParams.get("redirect_uri").endsWith("/contenido/callback/threads"), "enlace de Threads con retorno a tu sistema");
const malo = await C.contenidoHttp(new Request("https://h/contenido/callback/threads?code=c&state=falso"), env, new URL("https://h/contenido/callback/threads?code=c&state=falso"));
ok(malo.status === 400, "rechaza retorno con enlace falso");
const okTh = await P.callbackConexion(env, "threads", new URL(`https://h/contenido/callback/threads?code=c&state=${st}`), fake);
ok(okTh.status === 200 && JSON.parse(await env.HUB_KV.get("red:threads")).access_token === "largo", "Threads conectado con token de larga duración");
ok((await P.callbackConexion(env, "threads", new URL(`https://h/contenido/callback/threads?code=c&state=${st}`), fake)).status === 400, "el enlace no sirve dos veces");
const eLi = await P.enlaceConexion(env, { red: "linkedin" });
await P.callbackConexion(env, "linkedin", new URL(`https://h/contenido/callback/linkedin?code=c&state=${new URL(eLi.enlace).searchParams.get("state")}`), fake);
ok(JSON.parse(await env.HUB_KV.get("red:linkedin")).sub === "abc123", "LinkedIn conectado con tu perfil");

// Publicar
env.X_API_KEY = "k"; env.X_API_SECRET = "s"; env.X_ACCESS_TOKEN = "t"; env.X_ACCESS_SECRET = "ts";
for (const p of [x, th]) await C.actualizarPieza(env, { id: p.id, estado: "programada" });
await C.actualizarPieza(env, { id: li.id, estado: "programada", programada_para: new Date(Date.now() + 3600e3).toISOString() });
await P.pausarPublicacion(env, { pausa: true });
ok((await P.publicarPendientes(env, { fetchImpl: fake })).omitido, "freno de emergencia");
await P.pausarPublicacion(env, { pausa: false });
const r = await P.publicarPendientes(env, { fetchImpl: fake });
ok(r.resultados.length === 2 && r.resultados.every((z) => z.publicada), "publica X y Threads; LinkedIn espera su hora");
const tx = L.find((l) => l.url === "https://api.x.com/2/tweets");
ok(tx.init.headers.Authorization.startsWith("OAuth ") && JSON.parse(tx.init.body).text === "Post corto para X", "X firmado y con el texto exacto");
ok((await fila(x.id)).enlace_publicado === "https://x.com/i/web/status/111" && (await fila(th.id)).enlace_publicado.includes("threads.net"), "guarda enlaces publicados");
ok((await P.publicarPendientes(env, { fetchImpl: fake })).resultados.length === 0, "no publica dos veces");
await env.HUB_DB.prepare("UPDATE piezas SET programada_para = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), li.id).run();
await P.publicarPendientes(env, { fetchImpl: fake });
const pl = L.find((l) => l.url.includes("/rest/posts"));
ok(JSON.parse(pl.init.body).commentary === "Post \\(LinkedIn\\) \\#salud" && JSON.parse(pl.init.body).author === "urn:li:person:abc123", "LinkedIn con texto escapado y autor correcto");
ok((await fila(li.id)).enlace_publicado === "https://www.linkedin.com/feed/update/urn:li:share:333/", "enlace de LinkedIn");

// Fallas
const x2 = await mk("x", "Otro post", "aprobada"); await C.actualizarPieza(env, { id: x2.id, estado: "programada" });
modo.x = "429";
await P.publicarPendientes(env, { fetchImpl: fake });
ok((await fila(x2.id)).estado === "programada", "límite de uso: queda en cola para reintentar");
await P.publicarPendientes(env, { fetchImpl: fake }); await P.publicarPendientes(env, { fetchImpl: fake });
ok((await fila(x2.id)).estado === "aprobada", "tras 3 intentos vuelve a aprobada");
const t2 = await mk("threads", "Otro threads", "aprobada"); await C.actualizarPieza(env, { id: t2.id, estado: "programada" });
modo.th = "500pub";
await P.publicarPendientes(env, { fetchImpl: fake });
const f2 = await fila(t2.id);
ok(f2.estado === "aprobada" && /pudo haber salido/.test(f2.comentario), "si hay duda de que salió, no reintenta y avisa");

// Renovación automática de Threads
const tok = JSON.parse(await env.HUB_KV.get("red:threads"));
await env.HUB_KV.put("red:threads", JSON.stringify({ ...tok, expira: new Date(Date.now() + 10 * 86400e3).toISOString(), conectada: new Date(Date.now() - 50 * 86400e3).toISOString() }));
await P.renovarThreads(env, fake);
ok(JSON.parse(await env.HUB_KV.get("red:threads")).access_token === "renovado", "Threads se renueva solo antes de vencer");
const est = await P.estadoPublicacion(env);
ok(est.redes.x.lista && est.redes.threads.conectada && est.redes.linkedin.dias_restantes >= 59 && est.avisos.length === 0, "estado de publicación sin avisos");
await dispose();
