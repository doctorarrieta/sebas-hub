// TikTok: métricas oficiales de los videos (API de TikTok for Developers: Login Kit + Display API). Solo lectura.
// Funciona con cuenta de CREADOR. Da por video: vistas, me gusta, comentarios (cantidad), compartidos, duración.
// No da el texto de los comentarios ni el tiempo promedio (eso requiere cuenta de empresa + API for Business).
// Varias cuentas (Dr. Arrieta, Antifrágil, Anti Rebote): cada una se conecta con su propio enlace de un solo uso.
//
// Secretos (solo en Cloudflare): TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET.
// KV: "tt:cuenta:<usuario>" e índice "tt:cuentas". El token dura 24 h y se renueva solo con el refresh token (365 días).

const API = "https://open.tiktokapis.com/v2";
const ESCOPOS = "user.info.basic,user.info.profile,user.info.stats,video.list";
const now = () => new Date().toISOString();
const HORA = 3600e3;

const callbackUrl = (env) => `${env.BASE_URL || "https://sebas-contenido.sebastianarrietam.workers.dev"}/contenido/callback/tiktok`;
async function leerJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
const msgError = (j, res) => j?.error?.message || j?.error_description || j?.message || (j?.error && typeof j.error === "string" ? j.error : null) || `HTTP ${res.status}`;
const lista = async (env) => JSON.parse((await env.HUB_KV.get("tt:cuentas")) || "[]");
async function leerCuenta(env, u) {
  const s = await env.HUB_KV.get(`tt:cuenta:${u}`);
  return s ? JSON.parse(s) : null;
}
async function guardarCuenta(env, t) {
  await env.HUB_KV.put(`tt:cuenta:${t.usuario}`, JSON.stringify(t));
  const l = await lista(env);
  if (!l.includes(t.usuario)) await env.HUB_KV.put("tt:cuentas", JSON.stringify([...l, t.usuario]));
}
const vence = (s) => new Date(Date.now() + (Number(s) || 86400) * 1000).toISOString();

export async function enlaceTikTok(env) {
  if (!env.TIKTOK_CLIENT_KEY) throw new Error("Falta TIKTOK_CLIENT_KEY en Cloudflare.");
  const state = crypto.randomUUID();
  await env.HUB_KV.put(`oauth:estado:${state}`, "tiktok", { expirationTtl: 900 });
  const q = new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, scope: ESCOPOS, response_type: "code", redirect_uri: callbackUrl(env), state });
  return {
    red: "tiktok",
    enlace: `https://www.tiktok.com/v2/auth/authorize/?${q}`,
    vence_en_minutos: 15,
    nota: "Ábrelo donde tengas abierta la cuenta de TikTok que quieres conectar. Una cuenta por enlace.",
  };
}

export async function callbackTikTok(env, url, pagina, escHtml, f = fetch) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const esperado = state && (await env.HUB_KV.get(`oauth:estado:${state}`));
  if (esperado !== "tiktok") return pagina("Enlace vencido", "Pídele a Claude un enlace nuevo para conectar.", false);
  await env.HUB_KV.delete(`oauth:estado:${state}`);
  if (!code) return pagina("No se conectó", escHtml(url.searchParams.get("error_description") || "Se canceló la autorización."), false);
  try {
    const r1 = await f(`${API}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, code, grant_type: "authorization_code", redirect_uri: callbackUrl(env) }),
    });
    const j1 = await leerJson(r1);
    if (!j1.access_token) throw new Error(msgError(j1, r1));
    const perfil = await leerPerfil(j1.access_token, f);
    const usuario = perfil.username || perfil.display_name || j1.open_id;
    await guardarCuenta(env, {
      usuario,
      open_id: j1.open_id,
      access_token: j1.access_token,
      expira: vence(j1.expires_in),
      refresh_token: j1.refresh_token,
      refresh_expira: vence(j1.refresh_expires_in || 365 * 86400),
      escopos: j1.scope || ESCOPOS,
      conectada: now(),
    });
    return pagina("TikTok conectado", `Conectado: @${escHtml(usuario)}. Ya puedes cerrar esta pestaña. La conexión se renueva sola.`);
  } catch (e) {
    return pagina("No se conectó", escHtml(e.message), false);
  }
}

async function leerPerfil(token, f) {
  const r = await f(`${API}/user/info/?fields=open_id,display_name,username,follower_count,likes_count,video_count`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await leerJson(r);
  if (!r.ok || (j.error?.code && j.error.code !== "ok")) throw new Error(msgError(j, r));
  return j.data?.user || {};
}

// El token de acceso dura 24 h: se renueva cuando le queda menos de 2 h (o ya venció), con el refresh token.
async function renovarSiHaceFalta(env, t, f) {
  if (Date.parse(t.expira) - Date.now() > 2 * HORA) return t;
  if (!t.refresh_token || Date.parse(t.refresh_expira) < Date.now()) throw new Error("La conexión venció; hay que volver a conectar la cuenta.");
  const r = await f(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_key: env.TIKTOK_CLIENT_KEY, client_secret: env.TIKTOK_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const j = await leerJson(r);
  if (!j.access_token) throw new Error(`No se renovó: ${msgError(j, r)}`);
  const n = { ...t, access_token: j.access_token, expira: vence(j.expires_in), refresh_token: j.refresh_token || t.refresh_token, refresh_expira: j.refresh_expires_in ? vence(j.refresh_expires_in) : t.refresh_expira };
  await guardarCuenta(env, n);
  return n;
}

// Lo llama el cron: mantiene vivas todas las cuentas.
export async function renovarTikTok(env, f = fetch) {
  const out = [];
  for (const u of await lista(env)) {
    const t = await leerCuenta(env, u);
    if (!t) continue;
    try {
      const n = await renovarSiHaceFalta(env, t, f);
      if (n !== t) out.push({ usuario: u, renovada: true });
    } catch (e) {
      out.push({ usuario: u, error: e.message });
    }
  }
  return out;
}

export async function estadoTikTok(env) {
  const cuentas = [];
  for (const u of await lista(env)) {
    const t = await leerCuenta(env, u);
    cuentas.push({ usuario: u, dias_para_reconectar: t?.refresh_expira ? Math.floor((Date.parse(t.refresh_expira) - Date.now()) / 86400e3) : null });
  }
  return { configurada: !!(env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET), cuentas };
}

export async function metricasTikTok(env, a = {}, f = fetch) {
  const usuarios = a.cuenta ? [String(a.cuenta).replace(/^@/, "")] : await lista(env);
  if (!usuarios.length) return { error: "No hay cuentas de TikTok conectadas. Usa contenido_conectar_red con red 'tiktok'." };
  const limite = Math.min(Math.max(Number(a.limite) || 10, 1), 20);
  const out = [];
  for (const u of usuarios) {
    let t = await leerCuenta(env, u);
    if (!t) {
      out.push({ usuario: u, error: "Cuenta no conectada." });
      continue;
    }
    try {
      t = await renovarSiHaceFalta(env, t, f);
      const perfil = await leerPerfil(t.access_token, f);
      const campos = "id,title,video_description,create_time,duration,share_url,view_count,like_count,comment_count,share_count";
      const r = await f(`${API}/video/list/?fields=${campos}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ max_count: limite }),
      });
      const j = await leerJson(r);
      if (!r.ok || (j.error?.code && j.error.code !== "ok")) throw new Error(msgError(j, r));
      const videos = (j.data?.videos || []).map((v) => ({
        id: v.id,
        fecha: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
        enlace: v.share_url,
        texto: String(v.title || v.video_description || "").slice(0, 160),
        duracion_s: v.duration,
        vistas: v.view_count,
        me_gusta: v.like_count,
        comentarios: v.comment_count,
        compartidos: v.share_count,
        compartidos_por_mil: v.view_count ? Math.round((v.share_count / v.view_count) * 10000) / 10 : null,
      }));
      out.push({ usuario: perfil.username || u, seguidores: perfil.follower_count, me_gusta_totales: perfil.likes_count, videos_totales: perfil.video_count, recientes: videos });
    } catch (e) {
      out.push({ usuario: u, error: e.message });
    }
  }
  return { nota: "API básica de TikTok (cuenta de creador): no trae tiempo promedio, retención ni el texto de los comentarios.", cuentas: out };
}
