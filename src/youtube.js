// YouTube: métricas oficiales de los videos (YouTube Data API v3 + YouTube Analytics API). Solo lectura.
// Por video: vistas, me gusta, comentarios, minutos vistos, duración promedio vista, % promedio visto,
// suscriptores ganados y la CURVA COMPLETA DE RETENCIÓN (audienceWatchRatio por cada 1% del video).
// Varios canales (Dr. Arrieta, Antifrágil): cada uno se conecta con su propio enlace de un solo uso.
//
// Secretos (solo en Cloudflare): YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET (cliente OAuth "Aplicación web" de Google Cloud).
// KV: "yt:canal:<id>" e índice "yt:canales". El token de acceso dura 1 h y se renueva solo con el refresh token.

import { callbackDrive } from "./drive.js";

const ESCOPOS = "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly";
const DATA = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";
const now = () => new Date().toISOString();
const dia = (d) => d.toISOString().slice(0, 10);

const callbackUrl = (env) => `${env.BASE_URL || "https://sebas-contenido.sebastianarrietam.workers.dev"}/contenido/callback/youtube`;
async function leerJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
const msgError = (j, res) => j?.error?.message || j?.error_description || (typeof j?.error === "string" ? j.error : null) || `HTTP ${res.status}`;
const lista = async (env) => JSON.parse((await env.HUB_KV.get("yt:canales")) || "[]");
async function leerCanal(env, id) {
  const s = await env.HUB_KV.get(`yt:canal:${id}`);
  return s ? JSON.parse(s) : null;
}
async function guardarCanal(env, t) {
  await env.HUB_KV.put(`yt:canal:${t.id}`, JSON.stringify(t));
  const l = await lista(env);
  if (!l.includes(t.id)) await env.HUB_KV.put("yt:canales", JSON.stringify([...l, t.id]));
}

export async function enlaceYouTube(env) {
  if (!env.YOUTUBE_CLIENT_ID) throw new Error("Falta YOUTUBE_CLIENT_ID en Cloudflare.");
  const state = crypto.randomUUID();
  await env.HUB_KV.put(`oauth:estado:${state}`, "youtube", { expirationTtl: 900 });
  const q = new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID, redirect_uri: callbackUrl(env), response_type: "code", scope: ESCOPOS, access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state });
  return {
    red: "youtube",
    enlace: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
    vence_en_minutos: 15,
    nota: "Entra con la cuenta de Google dueña del canal y, si te pregunta, elige el canal (Dr. Arrieta o Antifrágil). Un canal por enlace. Si Google avisa que la app no está verificada: Configuración avanzada → Ir a Contenido Dr Arrieta (es tu propia app).",
  };
}

export async function callbackYouTube(env, url, pagina, escHtml, f = fetch) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const esperado = state && (await env.HUB_KV.get(`oauth:estado:${state}`));
  if (esperado === "drive") {
    await env.HUB_KV.delete(`oauth:estado:${state}`);
    return callbackDrive(env, url, pagina, escHtml, f);
  }
  if (esperado !== "youtube") return pagina("Enlace vencido", "Pídele a Claude un enlace nuevo para conectar.", false);
  await env.HUB_KV.delete(`oauth:estado:${state}`);
  if (!code) return pagina("No se conectó", escHtml(url.searchParams.get("error") || "Se canceló la autorización."), false);
  try {
    const r1 = await f("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID, client_secret: env.YOUTUBE_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: callbackUrl(env) }),
    });
    const j1 = await leerJson(r1);
    if (!j1.access_token) throw new Error(msgError(j1, r1));
    if (!j1.refresh_token) throw new Error("Google no entregó permiso permanente. Quita el acceso de la app en tu cuenta de Google y vuelve a conectar.");
    const r2 = await f(`${DATA}/channels?part=snippet,statistics,contentDetails&mine=true`, { headers: { Authorization: `Bearer ${j1.access_token}` } });
    const j2 = await leerJson(r2);
    const c = j2.items?.[0];
    if (!c) throw new Error(r2.ok ? "Esa cuenta de Google no tiene canal de YouTube. Vuelve a intentar y elige el canal correcto." : msgError(j2, r2));
    await guardarCanal(env, {
      id: c.id,
      nombre: c.snippet?.title,
      usuario: c.snippet?.customUrl || null,
      subidas: c.contentDetails?.relatedPlaylists?.uploads,
      access_token: j1.access_token,
      expira: new Date(Date.now() + (j1.expires_in || 3600) * 1000).toISOString(),
      refresh_token: j1.refresh_token,
      conectada: now(),
    });
    return pagina("YouTube conectado", `Conectado: ${escHtml(c.snippet?.title || c.id)}. Ya puedes cerrar esta pestaña. La conexión se renueva sola.`);
  } catch (e) {
    return pagina("No se conectó", escHtml(e.message), false);
  }
}

async function token(env, t, f) {
  if (Date.parse(t.expira) - Date.now() > 5 * 60e3) return t;
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID, client_secret: env.YOUTUBE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const j = await leerJson(r);
  if (!j.access_token) throw new Error(j.error === "invalid_grant" ? "La conexión venció o fue revocada; hay que volver a conectar el canal." : `No se renovó: ${msgError(j, r)}`);
  const n = { ...t, access_token: j.access_token, expira: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString() };
  await guardarCanal(env, n);
  return n;
}

export async function estadoYouTube(env) {
  const canales = [];
  for (const id of await lista(env)) canales.push({ id, nombre: (await leerCanal(env, id))?.nombre || null });
  return { configurada: !!(env.YOUTUBE_CLIENT_ID && env.YOUTUBE_CLIENT_SECRET), canales };
}

async function get(url, t, f) {
  const r = await f(url, { headers: { Authorization: `Bearer ${t.access_token}` } });
  const j = await leerJson(r);
  if (!r.ok) throw new Error(msgError(j, r));
  return j;
}
const filas = (j) => {
  const cols = (j.columnHeaders || []).map((c) => c.name);
  return (j.rows || []).map((r) => Object.fromEntries(r.map((v, i) => [cols[i], v])));
};
// "PT1H2M3S" → segundos
export function duracionSeg(iso) {
  const m = String(iso || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : null;
}

async function elegirCanal(env, cuenta) {
  const ids = await lista(env);
  if (!cuenta) return ids;
  const q = String(cuenta).toLowerCase().replace(/^@/, "");
  const out = [];
  for (const id of ids) {
    const c = await leerCanal(env, id);
    if (id.toLowerCase() === q || String(c?.usuario || "").toLowerCase().replace(/^@/, "") === q || String(c?.nombre || "").toLowerCase().includes(q)) out.push(id);
  }
  return out;
}

// Métricas de los videos recientes de cada canal. Con curva=true agrega la curva de retención de cada video.
export async function metricasYouTube(env, a = {}, f = fetch) {
  const ids = await elegirCanal(env, a.canal);
  if (!ids.length) return { error: a.canal ? `No encontré el canal "${a.canal}" entre los conectados.` : "No hay canales de YouTube conectados. Usa contenido_conectar_red con red 'youtube'." };
  const limite = Math.min(Math.max(Number(a.limite) || 10, 1), 25);
  const out = [];
  for (const id of ids) {
    let t = await leerCanal(env, id);
    try {
      t = await token(env, t, f);
      const canal = (await get(`${DATA}/channels?part=statistics&id=${id}`, t, f)).items?.[0]?.statistics || {};
      const pl = await get(`${DATA}/playlistItems?part=contentDetails&maxResults=${limite}&playlistId=${t.subidas}`, t, f);
      const vids = (pl.items || []).map((i) => i.contentDetails.videoId);
      if (!vids.length) {
        out.push({ canal: t.nombre, suscriptores: +canal.subscriberCount || null, recientes: [] });
        continue;
      }
      const det = await get(`${DATA}/videos?part=snippet,contentDetails,statistics&id=${vids.join(",")}`, t, f);
      const desde = "2005-01-01", hasta = dia(new Date());
      const an = filas(await get(`${ANALYTICS}?${new URLSearchParams({ ids: "channel==MINE", startDate: desde, endDate: hasta, dimensions: "video", metrics: "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes,comments,shares", filters: `video==${vids.join(",")}`, maxResults: String(vids.length) })}`, t, f));
      const porVideo = Object.fromEntries(an.map((r) => [r.video, r]));
      const recientes = [];
      for (const v of det.items || []) {
        const m = porVideo[v.id] || {};
        const dur = duracionSeg(v.contentDetails?.duration);
        const item = {
          id: v.id,
          fecha: v.snippet?.publishedAt,
          titulo: v.snippet?.title,
          enlace: `https://www.youtube.com/watch?v=${v.id}`,
          formato: dur != null && dur <= 180 ? "Short" : "Video largo",
          duracion_s: dur,
          vistas: +v.statistics?.viewCount || 0,
          me_gusta: +v.statistics?.likeCount || 0,
          comentarios: +v.statistics?.commentCount || 0,
          minutos_vistos: m.estimatedMinutesWatched ?? null,
          tiempo_prom_s: m.averageViewDuration ?? null,
          pct_visto: m.averageViewPercentage != null ? Math.round(m.averageViewPercentage * 10) / 1000 : null,
          suscriptores_ganados: m.subscribersGained ?? null,
          compartidos: m.shares ?? null,
        };
        if (a.curva) item.curva = await curvaRetencion(t, v.id, f).catch((e) => ({ error: e.message }));
        recientes.push(item);
      }
      out.push({ canal: t.nombre, suscriptores: +canal.subscriberCount || null, vistas_totales: +canal.viewCount || null, recientes });
    } catch (e) {
      out.push({ canal: t?.nombre || id, error: e.message });
    }
  }
  return { nota: "pct_visto en fracción (0,42 = 42%). La curva es la fracción de espectadores que sigue en cada punto del video (1 = 100%; puede pasar de 1 si la gente repite). Los datos de Analytics tardan 1–2 días en aparecer.", canales: out };
}

// Curva de retención de un video: [segundo, fracción que sigue], 100 puntos.
async function curvaRetencion(t, videoId, f) {
  const j = await get(`${ANALYTICS}?${new URLSearchParams({ ids: "channel==MINE", startDate: "2005-01-01", endDate: dia(new Date()), dimensions: "elapsedVideoTimeRatio", metrics: "audienceWatchRatio,relativeRetentionPerformance", filters: `video==${videoId}` })}`, t, f);
  return filas(j).map((r) => ({ t: r.elapsedVideoTimeRatio, sigue: Math.round(r.audienceWatchRatio * 1000) / 1000, vs_similares: r.relativeRetentionPerformance }));
}

export async function retencionYouTube(env, a = {}, f = fetch) {
  const ids = await elegirCanal(env, a.canal);
  if (!a.video) return { error: "Falta el id o enlace del video." };
  const vid = String(a.video).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1] || String(a.video).trim();
  for (const id of ids) {
    let t = await leerCanal(env, id);
    try {
      t = await token(env, t, f);
      const v = (await get(`${DATA}/videos?part=snippet,contentDetails&id=${vid}`, t, f)).items?.[0];
      if (!v || v.snippet?.channelId !== id) continue;
      const dur = duracionSeg(v.contentDetails?.duration);
      const pts = await curvaRetencion(t, vid, f);
      return { canal: t.nombre, video: vid, titulo: v.snippet?.title, duracion_s: dur, curva: pts.map((p) => ({ segundo: dur ? Math.round(p.t * dur) : null, ...p })) };
    } catch (e) {
      return { error: e.message };
    }
  }
  return { error: "El video no pertenece a ningún canal conectado." };
}
