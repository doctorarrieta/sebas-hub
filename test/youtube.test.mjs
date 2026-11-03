import { getPlatformProxy } from "wrangler";
import * as P from "../src/publicar.js";
import * as Y from "../src/youtube.js";
const { env, dispose } = await getPlatformProxy({ environment: "contenido", persist: false });
const ok = (c, m) => { if (!c) { console.error("FALLA:", m); process.exitCode = 1; } else console.log("ok -", m); };
env.YOUTUBE_CLIENT_ID = "ytid"; env.YOUTUBE_CLIENT_SECRET = "ytsec";
const R = (j, s = 200) => new Response(JSON.stringify(j), { status: s, headers: { "content-type": "application/json" } });
const L = [];
let sinRefresh = false;
const fake = async (url, init = {}) => {
  url = String(url); const body = init.body ? String(init.body) : ""; L.push({ url, body });
  if (url.includes("oauth2.googleapis.com/token") && body.includes("refresh_token=rt1")) return R({ access_token: "renovado", expires_in: 3599 });
  if (url.includes("oauth2.googleapis.com/token")) return R(sinRefresh ? { access_token: "a", expires_in: 3599 } : { access_token: "a1", refresh_token: "rt1", expires_in: 3599 });
  if (url.includes("/channels?part=snippet")) return R({ items: [{ id: "UC1", snippet: { title: "Dr. Arrieta", customUrl: "@doctorarrietam" }, contentDetails: { relatedPlaylists: { uploads: "UU1" } } }] });
  if (url.includes("/channels?part=statistics")) return R({ items: [{ statistics: { subscriberCount: "28000", viewCount: "3000000" } }] });
  if (url.includes("/playlistItems")) return R({ items: [{ contentDetails: { videoId: "abcdefghijk" } }, { contentDetails: { videoId: "zyxwvutsrqp" } }] });
  if (url.includes("/videos?part=snippet,contentDetails&id=abcdefghijk")) return R({ items: [{ id: "abcdefghijk", snippet: { title: "Testosterona", channelId: "UC1" }, contentDetails: { duration: "PT19M" } }] });
  if (url.includes("/videos?")) return R({ items: [
    { id: "abcdefghijk", snippet: { title: "Testosterona", publishedAt: "2026-10-30T15:00:00Z" }, contentDetails: { duration: "PT19M" }, statistics: { viewCount: "1500", likeCount: "90", commentCount: "12" } },
    { id: "zyxwvutsrqp", snippet: { title: "Short", publishedAt: "2026-10-31T15:00:00Z" }, contentDetails: { duration: "PT45S" }, statistics: { viewCount: "9000", likeCount: "300", commentCount: "4" } },
  ] });
  if (url.includes("dimensions=elapsedVideoTimeRatio")) return R({ columnHeaders: [{ name: "elapsedVideoTimeRatio" }, { name: "audienceWatchRatio" }, { name: "relativeRetentionPerformance" }], rows: [[0.01, 1.0, 0.5], [0.5, 0.31234, 0.6], [1, 0.12, 0.4]] });
  if (url.includes("dimensions=video")) return R({ columnHeaders: ["video", "views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage", "subscribersGained", "likes", "comments", "shares"].map((name) => ({ name })), rows: [["abcdefghijk", 1500, 4000, 160, 14.04, 30, 90, 12, 8]] });
  return R({ error: { message: "no" } }, 404);
};
const u = new URL((await P.enlaceConexion(env, { red: "youtube" })).enlace);
ok(u.host === "accounts.google.com" && u.searchParams.get("access_type") === "offline" && u.searchParams.get("scope").includes("yt-analytics.readonly") && u.searchParams.get("redirect_uri").endsWith("/contenido/callback/youtube"), "enlace oficial de Google, solo lectura y permanente");
const html = await (await P.callbackConexion(env, "youtube", new URL(`https://h/contenido/callback/youtube?code=c&state=${u.searchParams.get("state")}`), fake)).text();
ok(html.includes("Dr. Arrieta"), "conecta el canal");
sinRefresh = true;
const u2 = new URL((await P.enlaceConexion(env, { red: "youtube" })).enlace);
const html2 = await (await P.callbackConexion(env, "youtube", new URL(`https://h/x?code=c&state=${u2.searchParams.get("state")}`), fake)).text();
ok(html2.includes("permiso permanente"), "si Google no da refresh token, lo explica");
ok(Y.duracionSeg("PT1H2M3S") === 3723 && Y.duracionSeg("PT45S") === 45, "duración ISO a segundos");
const t = JSON.parse(await env.HUB_KV.get("yt:canal:UC1"));
await env.HUB_KV.put("yt:canal:UC1", JSON.stringify({ ...t, expira: new Date(Date.now() - 1000).toISOString() }));
const m = await Y.metricasYouTube(env, { canal: "doctorarrietam", curva: true }, fake);
const v = m.canales[0].recientes[0];
ok(L.some((x) => x.body.includes("grant_type=refresh_token")) && JSON.parse(await env.HUB_KV.get("yt:canal:UC1")).access_token === "renovado", "renueva el token vencido");
ok(m.canales[0].suscriptores === 28000 && v.formato === "Video largo" && v.tiempo_prom_s === 160 && v.pct_visto === 0.14 && v.suscriptores_ganados === 30, "métricas del video largo");
ok(m.canales[0].recientes[1].formato === "Short", "detecta Shorts");
ok(v.curva.length === 3 && v.curva[1].sigue === 0.312, "curva de retención incluida");
const r = await Y.retencionYouTube(env, { video: "https://www.youtube.com/watch?v=abcdefghijk" }, fake);
ok(r.duracion_s === 1140 && r.curva[1].segundo === 570 && r.curva[1].vs_similares === 0.6, "curva de un video con segundos");
await dispose();
