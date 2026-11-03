// Meta (Facebook + Instagram) con la app propia de Sebastián "Contenido Dr Arrieta", por la API oficial (Graph API).
// Se conecta con "Facebook Login for Business" (configuración de token de usuario): Sebastián abre un enlace de un
// solo uso, entra con su Facebook y elige la página Doctor Arrieta (y las demás que quiera). De ahí salen:
//   - Instagram: métricas de posts y reels de cada cuenta de Instagram vinculada a esas páginas (solo lectura).
//   - Facebook: publicar en la página (solo lo aprobado y programado por él, como en X).
// Los tokens de página que salen de un token de usuario de larga duración NO vencen (salvo que cambie su contraseña
// o quite el permiso): no hay que renovar nada.
//
// Secretos (solo en Cloudflare): META_APP_ID, META_APP_SECRET. Opcional: META_CONFIG_ID (si no, usa la configuración creada).
// KV: "meta:pagina:<page_id>" (token de página), índice "meta:paginas"; "ig:cuenta:<usuario>" e índice "ig:cuentas".

const V = "v25.0";
const G = `https://graph.facebook.com/${V}`;
const CONFIG_ID = "1649486460107140";
const now = () => new Date().toISOString();

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
const lista = async (env, k) => JSON.parse((await env.HUB_KV.get(k)) || "[]");
async function agregar(env, k, v) {
  const l = await lista(env, k);
  if (!l.includes(v)) await env.HUB_KV.put(k, JSON.stringify([...l, v]));
}
async function leer(env, k) {
  const s = await env.HUB_KV.get(k);
  return s ? JSON.parse(s) : null;
}
export const cuentasInstagram = (env) => lista(env, "ig:cuentas");
export const paginasFacebook = (env) => lista(env, "meta:paginas");

// ---------- Conectar (Facebook Login for Business) ----------
export async function enlaceInstagram(env) {
  if (!env.META_APP_ID) throw new Error("Falta META_APP_ID en Cloudflare.");
  const state = crypto.randomUUID();
  await env.HUB_KV.put(`oauth:estado:${state}`, "instagram", { expirationTtl: 900 });
  const q = new URLSearchParams({ client_id: env.META_APP_ID, redirect_uri: callbackUrl(env), config_id: env.META_CONFIG_ID || CONFIG_ID, response_type: "code", state });
  return {
    red: "facebook + instagram",
    enlace: `https://www.facebook.com/${V}/dialog/oauth?${q}`,
    vence_en_minutos: 15,
    nota: "Ábrelo donde tengas abierto tu Facebook. Elige la página Doctor Arrieta (y las de Antifrágil o Anti Rebote si las tienes) y sus cuentas de Instagram.",
  };
}

export async function callbackInstagram(env, url, pagina, escHtml, f = fetch) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const esperado = state && (await env.HUB_KV.get(`oauth:estado:${state}`));
  if (esperado !== "instagram") return pagina("Enlace vencido", "Pídele a Claude un enlace nuevo para conectar.", false);
  await env.HUB_KV.delete(`oauth:estado:${state}`);
  if (!code) return pagina("No se conectó", escHtml(url.searchParams.get("error_description") || url.searchParams.get("error_message") || "Se canceló la autorización."), false);
  try {
    const r1 = await f(`${G}/oauth/access_token?${new URLSearchParams({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: callbackUrl(env), code })}`);
    const j1 = await leerJson(r1);
    if (!j1.access_token) throw new Error(msgError(j1, r1));
    const r2 = await f(`${G}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: j1.access_token })}`);
    const j2 = await leerJson(r2);
    if (!j2.access_token) throw new Error(msgError(j2, r2));
    const r3 = await f(`${G}/me/accounts?${new URLSearchParams({ fields: "id,name,access_token,instagram_business_account{id,username}", limit: "50", access_token: j2.access_token })}`);
    const j3 = await leerJson(r3);
    if (!r3.ok) throw new Error(msgError(j3, r3));
    const pags = j3.data || [];
    if (!pags.length) throw new Error("No elegiste ninguna página. Vuelve a abrir un enlace nuevo y marca la página Doctor Arrieta.");
    const nombres = [];
    for (const p of pags) {
      if (!p.access_token) continue;
      await env.HUB_KV.put(`meta:pagina:${p.id}`, JSON.stringify({ id: p.id, nombre: p.name, access_token: p.access_token, conectada: now() }));
      await agregar(env, "meta:paginas", p.id);
      let txt = `Facebook: ${p.name}`;
      const ig = p.instagram_business_account;
      if (ig?.username) {
        await env.HUB_KV.put(`ig:cuenta:${ig.username}`, JSON.stringify({ usuario: ig.username, ig_id: ig.id, page_id: p.id, access_token: p.access_token, conectada: now() }));
        await agregar(env, "ig:cuentas", ig.username);
        txt += ` · Instagram: @${ig.username}`;
      }
      nombres.push(txt);
    }
    return pagina("Meta conectado", `${nombres.map(escHtml).join("<br>")}<br><br>Ya puedes cerrar esta pestaña. La conexión no vence.`);
  } catch (e) {
    return pagina("No se conectó", escHtml(e.message), false);
  }
}

// Los tokens de página no vencen: no hay nada que renovar. Se mantiene por compatibilidad con el cron.
export async function renovarInstagram() {
  return [];
}

export async function estadoInstagram(env) {
  const pags = [];
  for (const id of await paginasFacebook(env)) pags.push({ id, nombre: (await leer(env, `meta:pagina:${id}`))?.nombre || null });
  return {
    configurada: !!(env.META_APP_ID && env.META_APP_SECRET),
    paginas_facebook: pags,
    cuentas_instagram: await cuentasInstagram(env),
    vence: false,
  };
}

// ---------- Publicar en la página de Facebook ----------
// Publica en la primera página conectada, o en la que diga META_PAGINA_ID.
export async function publicarFacebook(env, texto, f = fetch) {
  const ids = await paginasFacebook(env);
  const id = env.META_PAGINA_ID || ids[0];
  const p = id && (await leer(env, `meta:pagina:${id}`));
  if (!p?.access_token) throw Object.assign(new Error("facebook: falta conectar la página (contenido_conectar_red con red 'instagram')."), { reintentable: false });
  let res;
  try {
    res = await f(`${G}/${p.id}/feed`, { method: "POST", body: new URLSearchParams({ message: texto, access_token: p.access_token }) });
  } catch (e) {
    throw Object.assign(new Error(`facebook: sin respuesta (${e.message})`), { dudoso: true });
  }
  const j = await leerJson(res);
  if (!res.ok || !j.id) {
    const espera = res.status === 429 || [4, 17, 32, 613].includes(j?.error?.code);
    throw Object.assign(new Error(`facebook: ${msgError(j, res)}${espera ? " (límite de uso, se reintenta luego)" : ""}`), { reintentable: espera, dudoso: res.status >= 500 });
  }
  const [pid, post] = String(j.id).split("_");
  return { id: j.id, url: post ? `https://www.facebook.com/${pid}/posts/${post}` : null };
}

// ---------- Métricas de Instagram ----------
async function insights(t, media, f) {
  const tipo = media.media_product_type === "REELS" ? "REELS" : media.media_product_type === "FEED" ? "FEED" : null;
  if (!tipo) return { sin_metricas: true };
  const pedir = async (ms) => {
    const r = await f(`${G}/${media.id}/insights?metric=${ms.join(",")}&access_token=${encodeURIComponent(t.access_token)}`);
    return { r, j: await leerJson(r) };
  };
  let { r, j } = await pedir(METRICAS[tipo]);
  // Si una métrica nueva no está disponible para esta cuenta, se pide sin ella.
  if (!r.ok && tipo === "REELS") ({ r, j } = await pedir(METRICAS.REELS.filter((m) => m !== "reels_skip_rate")));
  if (!r.ok) return { error: msgError(j, r) };
  const m = {};
  for (const d of j.data || []) m[d.name] = d.values?.[0]?.value ?? d.total_value?.value ?? null;
  // ig_reels_avg_watch_time viene en milisegundos; reels_skip_rate en porcentaje.
  if (m.ig_reels_avg_watch_time != null) m.tiempo_promedio_s = Math.round(m.ig_reels_avg_watch_time / 100) / 10;
  if (m.reels_skip_rate != null) m.retencion_3s = Math.round((100 - m.reels_skip_rate) * 10) / 1000;
  return m;
}

export async function metricasInstagram(env, a = {}, f = fetch) {
  const usuarios = a.cuenta ? [String(a.cuenta).replace(/^@/, "")] : await cuentasInstagram(env);
  if (!usuarios.length) return { error: "No hay cuentas de Instagram conectadas. Usa contenido_conectar_red con red 'instagram'." };
  const limite = Math.min(Math.max(Number(a.limite) || 10, 1), 30);
  const out = [];
  for (const u of usuarios) {
    const t = await leer(env, `ig:cuenta:${u}`);
    if (!t?.ig_id) {
      out.push({ usuario: u, error: "Cuenta no conectada." });
      continue;
    }
    const tok = encodeURIComponent(t.access_token);
    const rp = await f(`${G}/${t.ig_id}?fields=username,followers_count,media_count&access_token=${tok}`);
    const perfil = await leerJson(rp);
    if (!rp.ok) {
      out.push({ usuario: u, error: msgError(perfil, rp) });
      continue;
    }
    const rm = await f(`${G}/${t.ig_id}/media?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=${limite}&access_token=${tok}`);
    const jm = await leerJson(rm);
    if (!rm.ok) {
      out.push({ usuario: u, error: msgError(jm, rm) });
      continue;
    }
    const pubs = [];
    for (const m of jm.data || []) {
      pubs.push({ id: m.id, fecha: m.timestamp, tipo: m.media_product_type, formato: m.media_type, enlace: m.permalink, texto: String(m.caption || "").slice(0, 160), metricas: await insights(t, m, f) });
    }
    out.push({ usuario: perfil.username, seguidores: perfil.followers_count, publicaciones: perfil.media_count, recientes: pubs });
  }
  return { nota: "Los datos pueden tardar hasta 48 h en estabilizarse. retencion_3s = 1 − reels_skip_rate (estimado por Instagram). La curva completa de retención no está en la API.", cuentas: out };
}
