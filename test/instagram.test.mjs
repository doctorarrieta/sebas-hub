import { getPlatformProxy } from "wrangler";
import * as P from "../src/publicar.js";
import * as I from "../src/instagram.js";
const { env, dispose } = await getPlatformProxy({ environment: "contenido", persist: false });
const ok = (c, m) => { if (!c) { console.error("FALLA:", m); process.exitCode = 1; } else console.log("ok -", m); };
env.META_APP_ID = "metaapp"; env.META_APP_SECRET = "metasec";
const R = (j, s = 200) => new Response(JSON.stringify(j), { status: s, headers: { "content-type": "application/json" } });
const L = [];
let fbFalla = false;
const fake = async (url, init = {}) => {
  url = String(url); L.push({ url, body: init.body ? String(init.body) : "" });
  if (url.includes("/oauth/access_token") && url.includes("fb_exchange_token")) return R({ access_token: "largo", token_type: "bearer" });
  if (url.includes("/oauth/access_token")) return R({ access_token: "corto" });
  if (url.includes("/me/accounts")) return R({ data: [
    { id: "500", name: "Doctor Arrieta", access_token: "pag500", instagram_business_account: { id: "17", username: "doctorarrietam" } },
    { id: "600", name: "Método Antifrágil", access_token: "pag600", instagram_business_account: { id: "18", username: "metodoantifragil" } },
  ] });
  if (url.includes("/17?fields=username")) return R({ username: "doctorarrietam", followers_count: 1200000, media_count: 5000 });
  if (url.includes("/17/media")) return R({ data: [{ id: "1", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://instagram.com/reel/1", timestamp: "2026-10-31T15:00:00+0000", caption: "Tu minoxidil" }, { id: "2", media_type: "CAROUSEL_ALBUM", media_product_type: "FEED", permalink: "https://instagram.com/p/2", timestamp: "2026-10-30T15:00:00+0000" }] });
  if (url.includes("/1/insights") && url.includes("reels_skip_rate")) return R({ error: { message: "metric not supported" } }, 400);
  if (url.includes("/1/insights")) return R({ data: [{ name: "views", values: [{ value: 48500 }] }, { name: "ig_reels_avg_watch_time", values: [{ value: 11400 }] }] });
  if (url.includes("/2/insights")) return R({ data: [{ name: "saved", values: [{ value: 900 }] }] });
  if (url.includes("/500/feed")) return fbFalla ? R({ error: { message: "Rate limit", code: 4 } }, 400) : R({ id: "500_999" });
  return R({ error: { message: "no" } }, 404);
};
const e = await P.enlaceConexion(env, { red: "instagram" });
const u = new URL(e.enlace);
ok(u.host === "www.facebook.com" && u.pathname === "/v25.0/dialog/oauth" && u.searchParams.get("config_id") === "1649486460107140" && u.searchParams.get("redirect_uri").endsWith("/contenido/callback/instagram"), "enlace oficial de Facebook Login for Business con la configuración");
const html = await (await P.callbackConexion(env, "instagram", new URL(`https://h/contenido/callback/instagram?code=abc&state=${u.searchParams.get("state")}`), fake)).text();
ok(html.includes("Doctor Arrieta") && html.includes("@doctorarrietam") && html.includes("@metodoantifragil"), "conecta páginas e Instagram vinculados");
ok(L.some((x) => x.url.includes("fb_exchange_token=corto")), "pide token de larga duración");
const est = await I.estadoInstagram(env);
ok(est.paginas_facebook.length === 2 && est.cuentas_instagram.length === 2 && est.vence === false, "estado: 2 páginas, 2 Instagram, no vence");
const html2 = await (await P.callbackConexion(env, "instagram", new URL(`https://h/x?code=c&state=${u.searchParams.get("state")}`), fake)).text();
ok(html2.includes("vencido"), "el enlace es de un solo uso");
const m = await I.metricasInstagram(env, { cuenta: "doctorarrietam" }, fake);
const reel = m.cuentas[0].recientes[0];
ok(reel.metricas.views === 48500 && reel.metricas.tiempo_promedio_s === 11.4, "reel: vistas y tiempo promedio (reintenta sin la métrica no disponible)");
ok(L.some((x) => x.url.includes("graph.facebook.com/v25.0/1/insights?metric=views,reach,likes,comments,shares,saved,total_interactions,ig_reels_avg_watch_time&")), "segunda consulta sin reels_skip_rate");
ok(m.cuentas[0].recientes[1].metricas.saved === 900, "post de carrusel con sus métricas");
// Publicar en la página de Facebook
ok(P.validarParaPublicar({ formato: "facebook", texto: "Hola", referencia: "Hull et al., 2026", referencia_url: "https://pubmed.ncbi.nlm.nih.gov/1/" }).endsWith("Referencia: Hull et al., 2026\nhttps://pubmed.ncbi.nlm.nih.gov/1/"), "facebook: la referencia va al final del post");
let err = null;
try { P.validarParaPublicar({ formato: "facebook", texto: "Hola" }); } catch (x) { err = x; }
ok(err && /referencia/.test(err.message), "facebook: sin referencia no sale");
const r = await I.publicarFacebook(env, "Texto", fake);
ok(r.id === "500_999" && r.url === "https://www.facebook.com/500/posts/999", "publica en la primera página conectada");
const pub = L.find((x) => x.url.includes("/500/feed"));
ok(pub.body.includes("access_token=pag500") && pub.body.includes("message=Texto"), "usa el token de la página");
fbFalla = true;
let e3 = null;
try { await I.publicarFacebook(env, "Texto", fake); } catch (x) { e3 = x; }
ok(e3 && e3.reintentable === true, "límite de uso de Facebook: se reintenta luego");
ok((await I.renovarInstagram(env, fake)).length === 0, "no hay tokens que renovar");
await dispose();
