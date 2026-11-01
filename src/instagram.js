// Instagram: métricas oficiales de posts y reels (API de Instagram con inicio de sesión de Instagram).
// Solo lectura: permisos instagram_business_basic + instagram_business_manage_insights. No publica nada.
// Varias cuentas (Dr. Arrieta, Antifrágil, Anti Rebote): cada una se conecta con su propio enlace de un solo uso.
//
// Secretos (solo en Cloudflare): INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET.
// Tokens en KV: "ig:cuenta:<usuario>" (60 días, se renuevan solos) e índice "ig:cuentas".

const API = "https://graph.instagram.com/v26.0";
const DIA = 86400e3;
const now = () => new Date().toISOString();
const ESCOPOS = "instagram_business_basic,instagram_business_manage_insights";

// Métricas por tipo de publicación (las que no aplican hacen fallar toda la consulta, por eso van separadas).
export const METRICAS = {
  REELS: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "ig_reels_avg_watch_time", "reels_skip_rate"],
  FEED: ["views", "reach", "likes", "comments", "shares", "saved", "total_interactions", "follows", "profile_visits"],
};

const callbackUrl = (env) => `${env.BASE_URL || "https://sebas-contenido.sebastianarrietam.workers.dev"}/contenido/callback/instagram`;
async function leerJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
const msgError = (j, res) => j?.error?.message || j?.error_message || j?.message || `HTTP ${res.status}`;

async function cuentas(env) {
  return JSON.parse((await env.HUB_KV.get("ig:cuentas")) || "[]");
}
async function leerCuenta(env, usuario) {
  const s = await env.HUB_KV.get(`ig:cuenta:${usuario}`);
  return s ? JSON.parse(s) : null;
}
async function guardarCuenta(env, t) {
  await env.HUB_KV.put(`ig:cuenta:${t.usuario}`, JSON.stringify(t));
  const l = await cuentas(env);
  if (!l.includes(t.usuario)) await env.HUB_KV.put("ig:cuentas", JSON.stringify([...l, t.usuario]));
}

// ---------- Conectar una cuenta ----------
export async function enlaceInstagram(env) {
  if (!env.INSTAGRAM_APP_ID) throw new Error("Falta INSTAGRAM_APP_ID en Cloudflare.");
  const state = crypto.randomUUID();
  await env.HUB_KV.put(`oauth:estado:${state}`, "instagram", { expirationTtl: 900 });
  const q = new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID, redirect_uri: callbackUrl(env), response_type: "code", scope: ESCOPOS, state });
  return {
    red: "instagram",
    enlace: `https://www.instagram.com/oauth/authorize?${q}`,
    vence_en_minutos: 15,
    nota: "Ábrelo en un navegador donde esté abierta la cuenta de Instagram que quieres conectar (o cierra sesión y entra con esa). Una cuenta por enlace.",
  };
}

export async function callbackInstagram(env, url, pagina, escHtml, f = fetch) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const esperado = state && (await env.HUB_KV.get(`oauth:estado:${state}`));
  if (esperado !== "instagram") return pagina("Enlace vencido", "Pídele a Claude un enlace nuevo para conectar.", false);
  await env.HUB_KV.delete(`oauth:estado:${state}`);
  if (!code) return pagina("No se conectó", escHtml(url.searchParams.get("error_description") || "Se canceló la autorización."), false);
  try {
    const r1 = await f("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      body: new URLSearchParams({ client_id: env.INSTAGRAM_APP_ID, client_secret: env.INSTAGRAM_APP_SECRET, grant_type: "authorization_code", redirect_uri: callbackUrl(env), code: code.replace(/#_$/, "") }),
    });
    let j1 = await leerJson(r1);
    if (Array.isArray(j1.data)) j1 = j1.data[0] || {};
    if (!j1.access_token) throw new Error(msgError(j1, r1));
    const r2 = await f(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: env.INSTAGRAM_APP_SECRET, access_token: j1.access_token })}`);
    const j2 = await leerJson(r2);
    if (!j2.access_token) throw new Error(msgError(j2, r2));
    const r3 = await f(`${API}/me?fields=user_id,username,account_type&access_token=${encodeURIComponent(j2.access_token)}`);
    const j3 = await leerJson(r3);
    if (!j3.username) throw new Error(msgError(j3, r3));
    await guardarCuenta(env, {
      usuario: j3.username,
      ig_id: String(j3.user_id || j1.user_id || ""),
      tipo: j3.account_type || null,
      access_token: j2.access_token,
      expira: new Date(Date.now() + (j2.expires_in || 60 * 86400) * 1000).toISOString(),
      conectada: now(),
    });
    return pagina("Instagram conectado", `Conectado: @${escHtml(j3.username)}. Ya puedes cerrar esta pestaña. La conexión se renueva sola.`);
  } catch (e) {
    return pagina("No se conectó", escHtml(e.message), false);
  }
}

// El token dura 60 días y se puede renovar si tiene más de 24 h. Se renueva cuando le quedan menos de 20 días.
export async function renovarInstagram(env, f = fetch) {
  const out = [];
  for (const u of await cuentas(env)) {
    const t = await leerCuenta(env, u);
    if (!t?.access_token || !t.expira) continue;
    const queda = Date.parse(t.expira) - Date.now();
    if (queda <= 0 || queda > 20 * DIA || Date.now() - Date.parse(t.conectada || 0) < DIA) continue;
    const r = await f(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: t.access_token })}`);
    const j = await leerJson(r);
    if (!j.access_token) {
      out.push({ usuario: u, error: msgError(j, r) });
      continue;
    }
    await guardarCuenta(env, { ...t, access_token: j.access_token, expira: new Date(Date.now() + (j.expires_in || 60 * 86400) * 1000).toISOString(), conectada: now() });
    out.push({ usuario: u, renovada: true });
  }
  return out;
}

export async function estadoInstagram(env) {
  const l = [];
  for (const u of await cuentas(env)) {
    const t = await leerCuenta(env, u);
    l.push({ usuario: u, tipo: t?.tipo, dias_restantes: t?.expira ? Math.floor((Date.parse(t.expira) - Date.now()) / DIA) : null, se_renueva_sola: true });
  }
  return { configurada: !!(env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET), cuentas: l };
}

// ---------- Métricas ----------
async function insights(t, media, f) {
  const tipo = media.media_product_type === "REELS" ? "REELS" : media.media_product_type === "FEED" ? "FEED" : null;
  if (!tipo || media.media_type === "CAROUSEL_ALBUM" && tipo !== "FEED") return { sin_metricas: true };
  const r = await f(`${API}/${media.id}/insights?metric=${METRICAS[tipo].join(",")}&access_token=${encodeURIComponent(t.access_token)}`);
  const j = await leerJson(r);
  if (!r.ok) return { error: msgError(j, r) };
  const m = {};
  for (const d of j.data || []) m[d.name] = d.values?.[0]?.value ?? d.total_value?.value ?? null;
  // ig_reels_avg_watch_time viene en milisegundos; reels_skip_rate en porcentaje.
  if (m.ig_reels_avg_watch_time != null) m.tiempo_promedio_s = Math.round(m.ig_reels_avg_watch_time / 100) / 10;
  if (m.reels_skip_rate != null) m.retencion_3s = Math.round((100 - m.reels_skip_rate) * 10) / 1000;
  return m;
}

export async function metricasInstagram(env, a = {}, f = fetch) {
  const lista = a.cuenta ? [String(a.cuenta).replace(/^@/, "")] : await cuentas(env);
  if (!lista.length) return { error: "No hay cuentas de Instagram conectadas. Usa contenido_conectar_red con red 'instagram'." };
  const limite = Math.min(Math.max(Number(a.limite) || 10, 1), 30);
  const out = [];
  for (const u of lista) {
    const t = await leerCuenta(env, u);
    if (!t) {
      out.push({ usuario: u, error: "Cuenta no conectada." });
      continue;
    }
    const tok = encodeURIComponent(t.access_token);
    const rp = await f(`${API}/me?fields=username,followers_count,media_count&access_token=${tok}`);
    const perfil = await leerJson(rp);
    if (!rp.ok) {
      out.push({ usuario: u, error: msgError(perfil, rp) });
      continue;
    }
    const rm = await f(`${API}/me/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=${limite}&access_token=${tok}`);
    const jm = await leerJson(rm);
    if (!rm.ok) {
      out.push({ usuario: u, error: msgError(jm, rm) });
      continue;
    }
    const pubs = [];
    for (const m of jm.data || []) {
      pubs.push({
        id: m.id,
        fecha: m.timestamp,
        tipo: m.media_product_type,
        formato: m.media_type,
        enlace: m.permalink,
        texto: String(m.caption || "").slice(0, 160),
        metricas: await insights(t, m, f),
      });
    }
    out.push({ usuario: perfil.username, seguidores: perfil.followers_count, publicaciones: perfil.media_count, recientes: pubs });
  }
  return { nota: "Los datos pueden tardar hasta 48 h en estabilizarse. retencion_3s = 1 − reels_skip_rate (estimado por Instagram, en desarrollo). La curva completa de retención no está en la API.", cuentas: out };
}
