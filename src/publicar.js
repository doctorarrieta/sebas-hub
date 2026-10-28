// Publicación automática en X, Threads y LinkedIn, DIRECTO por la API oficial de cada red,
// con apps de desarrollador propias de Sebastián (sin intermediarios).
//
// Regla de oro: solo se publica lo que Sebastián aprobó y luego programó.
//   aprobada → (él pulsa "Programar" o "Publicar ahora" en la Mesa) → programada → publicada
// Cada 5 minutos el cron publica las piezas programadas cuya hora ya llegó.
//
// Nunca publicar dos veces: si una red falla, la pieza vuelve a "aprobada" con el error a la vista.
// Solo se reintenta sola cuando la red dice "espera" (límite de uso) o cuando el fallo ocurrió
// ANTES de publicar. Si hay duda de si salió, no se reintenta: se avisa para revisar.
//
// Secretos (solo en Cloudflare):
//   X:        X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET  (OAuth 1.0a de su propia cuenta)
//   Threads:  THREADS_APP_ID, THREADS_APP_SECRET   → token en KV tras conectar (se renueva solo)
//   LinkedIn: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET → token en KV tras conectar (dura 60 días)
// Freno de emergencia: KV "publicar:pausa" = "1".

export const REDES = ["x", "threads", "linkedin"];
export const RED = { x: "x", threads: "threads", linkedin: "linkedin" };
export const LIMITE = { x: 280, threads: 500, linkedin: 3000 };
const MAX_INTENTOS = 3;
const DIA = 86400e3;
const now = () => new Date().toISOString();

class ErrorRed extends Error {
  constructor(msg, { reintentable = false, dudoso = false } = {}) {
    super(msg);
    this.reintentable = reintentable; // seguro reintentar: no se publicó nada
    this.dudoso = dudoso; // pudo haber salido: no reintentar, revisar
  }
}

// X cuenta los enlaces como 23 caracteres y algunos símbolos como 2; conteo prudente.
export function largo(formato, texto) {
  const t = String(texto || "");
  if (formato !== "x") return [...t].length;
  return [...t.replace(/https?:\/\/\S+/g, "x".repeat(23))].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2fff ? 2 : 1), 0);
}

export function validarParaPublicar(p) {
  if (!RED[p.formato]) throw new Error(`Solo se publica sola en X, Threads y LinkedIn (esta pieza es ${p.formato}).`);
  const texto = String(p.texto || "").trim();
  if (!texto) throw new Error("La pieza no tiene texto para publicar.");
  const n = largo(p.formato, texto);
  if (n > LIMITE[p.formato]) throw new Error(`Muy larga para ${p.formato}: ${n} caracteres (máximo ${LIMITE[p.formato]}).`);
  return texto;
}

const baseUrl = (env) => env.BASE_URL || "https://sebas-contenido.sebastianarrietam.workers.dev";
const callbackUrl = (env, red) => `${baseUrl(env)}/contenido/callback/${red}`;
const tokenKey = (red) => `red:${red}`;
async function leerToken(env, red) {
  const s = await env.HUB_KV.get(tokenKey(red));
  return s ? JSON.parse(s) : null;
}
const guardarToken = (env, red, t) => env.HUB_KV.put(tokenKey(red), JSON.stringify(t));

async function leerJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
function errorHttp(red, res, j, etapa) {
  const msg = j?.detail || j?.error?.message || j?.message || j?.title || j?.error_description || `HTTP ${res.status}`;
  const espera = res.status === 429;
  return new ErrorRed(`${red}: ${msg}${espera ? " (límite de uso, se reintenta luego)" : ""}`, {
    reintentable: espera || (etapa === "antes" && res.status >= 500),
    dudoso: etapa === "publicar" && res.status >= 500,
  });
}

// ---------- X (OAuth 1.0a, tokens de su propia cuenta) ----------
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export async function firmaOAuth1({ method, url, params, consumerSecret, tokenSecret }) {
  const norm = Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join("&");
  const base = `${method.toUpperCase()}&${enc(url)}&${enc(norm)}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${enc(consumerSecret)}&${enc(tokenSecret)}`), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base)));
  return btoa(String.fromCharCode(...sig));
}

async function cabeceraOAuth1(env, method, url) {
  const o = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  o.oauth_signature = await firmaOAuth1({ method, url, params: o, consumerSecret: env.X_API_SECRET, tokenSecret: env.X_ACCESS_SECRET });
  return "OAuth " + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k])}"`).join(", ");
}

const xListo = (env) => !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET);

async function publicarX(env, texto, f) {
  if (!xListo(env)) throw new ErrorRed("x: faltan las llaves de X en Cloudflare.");
  const url = "https://api.x.com/2/tweets";
  let res;
  try {
    res = await f(url, { method: "POST", headers: { Authorization: await cabeceraOAuth1(env, "POST", url), "Content-Type": "application/json" }, body: JSON.stringify({ text: texto }) });
  } catch (e) {
    throw new ErrorRed(`x: sin respuesta (${e.message})`, { dudoso: true });
  }
  const j = await leerJson(res);
  if (!res.ok || !j?.data?.id) throw errorHttp("x", res, j, "publicar");
  return { id: j.data.id, url: `https://x.com/i/web/status/${j.data.id}` };
}

// ---------- Threads (API oficial de Meta) ----------
const TH = "https://graph.threads.net";

async function publicarThreads(env, texto, f) {
  const t = await leerToken(env, "threads");
  if (!t?.access_token) throw new ErrorRed("threads: falta conectar la cuenta (contenido_conectar_red).");
  if (t.expira && Date.parse(t.expira) < Date.now()) throw new ErrorRed("threads: la conexión venció; vuelve a conectar.");
  const form = (o) => new URLSearchParams({ ...o, access_token: t.access_token });
  // 1) contenedor (aún no se publica nada)
  let res;
  try {
    res = await f(`${TH}/v1.0/me/threads`, { method: "POST", body: form({ media_type: "TEXT", text: texto }) });
  } catch (e) {
    throw new ErrorRed(`threads: sin respuesta (${e.message})`, { reintentable: true });
  }
  let j = await leerJson(res);
  if (!res.ok || !j.id) throw errorHttp("threads", res, j, "antes");
  // 2) publicar
  try {
    res = await f(`${TH}/v1.0/me/threads_publish`, { method: "POST", body: form({ creation_id: j.id }) });
  } catch (e) {
    throw new ErrorRed(`threads: sin respuesta al publicar (${e.message})`, { dudoso: true });
  }
  j = await leerJson(res);
  if (!res.ok || !j.id) throw errorHttp("threads", res, j, "publicar");
  const id = j.id;
  // 3) enlace (si falla, igual quedó publicada)
  let url = null;
  try {
    const r = await f(`${TH}/v1.0/${id}?fields=permalink&access_token=${encodeURIComponent(t.access_token)}`);
    url = (await leerJson(r)).permalink || null;
  } catch {}
  return { id, url };
}

// ---------- LinkedIn (API oficial, perfil personal) ----------
// LinkedIn exige una versión mensual (AAAAMM) vigente: usamos la de hace 2 meses, siempre soportada.
export function versionLinkedIn(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1));
  return `${x.getUTCFullYear()}${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
}
// En el texto de LinkedIn estos caracteres son reservados y deben ir escapados.
export const escaparLinkedIn = (s) => String(s).replace(/[\\|{}@[\]()<>#*_~]/g, "\\$&");

async function publicarLinkedIn(env, texto, f) {
  const t = await leerToken(env, "linkedin");
  if (!t?.access_token || !t.sub) throw new ErrorRed("linkedin: falta conectar la cuenta (contenido_conectar_red).");
  if (t.expira && Date.parse(t.expira) < Date.now()) throw new ErrorRed("linkedin: la conexión venció (dura 60 días); vuelve a conectar.");
  let res;
  try {
    res = await f("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${t.access_token}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": versionLinkedIn(),
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: `urn:li:person:${t.sub}`,
        commentary: escaparLinkedIn(texto),
        visibility: "PUBLIC",
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });
  } catch (e) {
    throw new ErrorRed(`linkedin: sin respuesta (${e.message})`, { dudoso: true });
  }
  if (res.status !== 201) throw errorHttp("linkedin", res, await leerJson(res), "publicar");
  const urn = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id");
  return { id: urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
}

const PUBLICAR = { x: publicarX, threads: publicarThreads, linkedin: publicarLinkedIn };

export async function pausada(env) {
  return (await env.HUB_KV.get("publicar:pausa")) === "1";
}

// Lo que corre el cron cada 5 minutos.
export async function publicarPendientes(env, { fetchImpl = fetch, limite = 3 } = {}) {
  await renovarThreads(env, fetchImpl).catch((e) => console.error("renovar threads", e.message));
  if (await pausada(env)) return { omitido: "Publicación en pausa" };
  const { results } = await env.HUB_DB.prepare(
    `SELECT * FROM piezas WHERE estado = 'programada' AND formato IN ('x','threads','linkedin')
       AND programada_para IS NOT NULL AND programada_para <= ? AND publicar_intentos < ?
     ORDER BY programada_para LIMIT ?`
  ).bind(now(), MAX_INTENTOS, limite).all();
  const out = [];
  for (const p of results) {
    // Reserva la pieza: si dos ejecuciones coinciden, solo una la publica.
    const claim = await env.HUB_DB.prepare(
      "UPDATE piezas SET publicar_intentos = publicar_intentos + 1, actualizada = ? WHERE id = ? AND estado = 'programada' AND publicar_intentos = ?"
    ).bind(now(), p.id, p.publicar_intentos).run();
    if (!claim.meta?.changes) continue;
    try {
      const texto = validarParaPublicar(p);
      const r = await PUBLICAR[p.formato](env, texto, fetchImpl);
      const t = now();
      await env.HUB_DB.prepare(
        "UPDATE piezas SET estado = 'publicada', fecha_publicacion = ?, enlace_publicado = ?, red_id = ?, publicar_error = NULL, actualizada = ? WHERE id = ?"
      ).bind(t, r.url, r.id, t, p.id).run();
      if (p.idea_id) await env.HUB_DB.prepare("UPDATE ideas SET estado = 'usada', actualizada = ? WHERE id = ?").bind(t, p.idea_id).run();
      out.push({ id: p.id, formato: p.formato, publicada: true, enlace: r.url });
    } catch (e) {
      const intentos = p.publicar_intentos + 1;
      const devolver = !e.reintentable || intentos >= MAX_INTENTOS;
      const msg = (e.dudoso ? `${e.message}. OJO: pudo haber salido; revisa la red antes de volver a programarla.` : e.message).slice(0, 1000);
      await env.HUB_DB.prepare(
        `UPDATE piezas SET publicar_error = ?, actualizada = ?${devolver ? ", estado = 'aprobada', programada_para = NULL, comentario = ?" : ""} WHERE id = ?`
      ).bind(...[msg, now(), ...(devolver ? [`No se publicó en ${p.formato}: ${msg}`.slice(0, 1000)] : []), p.id]).run();
      out.push({ id: p.id, formato: p.formato, publicada: false, error: msg, intentos, devuelta_a_aprobada: devolver });
    }
  }
  return { revisadas: results.length, resultados: out };
}

// ---------- Conexión de cuentas (OAuth) ----------
// Claude genera un enlace de un solo uso (vale 15 minutos); Sebastián lo abre, entra con su cuenta y autoriza.
export async function enlaceConexion(env, a = {}) {
  const red = a.red;
  if (!["threads", "linkedin"].includes(red)) throw new Error('red debe ser "threads" o "linkedin" (X se conecta con sus llaves en Cloudflare).');
  const state = crypto.randomUUID();
  await env.HUB_KV.put(`oauth:estado:${state}`, red, { expirationTtl: 900 });
  if (red === "threads") {
    if (!env.THREADS_APP_ID) throw new Error("Falta THREADS_APP_ID en Cloudflare.");
    const q = new URLSearchParams({ client_id: env.THREADS_APP_ID, redirect_uri: callbackUrl(env, red), scope: "threads_basic,threads_content_publish", response_type: "code", state });
    return { red, enlace: `https://threads.net/oauth/authorize?${q}`, vence_en_minutos: 15 };
  }
  if (!env.LINKEDIN_CLIENT_ID) throw new Error("Falta LINKEDIN_CLIENT_ID en Cloudflare.");
  const q = new URLSearchParams({ response_type: "code", client_id: env.LINKEDIN_CLIENT_ID, redirect_uri: callbackUrl(env, red), state, scope: "openid profile w_member_social" });
  return { red, enlace: `https://www.linkedin.com/oauth/v2/authorization?${q}`, vence_en_minutos: 15 };
}

const pagina = (titulo, texto, ok = true) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><body style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 16px;text-align:center"><h1>${ok ? "✅" : "⚠️"} ${titulo}</h1><p>${texto}</p></body>`,
    { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } }
  );
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export async function callbackConexion(env, red, url, f = fetch) {
  const state = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code");
  const esperado = state && (await env.HUB_KV.get(`oauth:estado:${state}`));
  if (!esperado || esperado !== red) return pagina("Enlace vencido", "Pídele a Claude un enlace nuevo para conectar.", false);
  await env.HUB_KV.delete(`oauth:estado:${state}`);
  if (!code) return pagina("No se conectó", escHtml(url.searchParams.get("error_description") || "Se canceló la autorización."), false);
  try {
    if (red === "threads") {
      const r1 = await f(`${TH}/oauth/access_token`, {
        method: "POST",
        body: new URLSearchParams({ client_id: env.THREADS_APP_ID, client_secret: env.THREADS_APP_SECRET, grant_type: "authorization_code", redirect_uri: callbackUrl(env, red), code }),
      });
      const j1 = await leerJson(r1);
      if (!j1.access_token) throw new Error(j1?.error?.message || "no entregó token");
      const r2 = await f(`${TH}/access_token?${new URLSearchParams({ grant_type: "th_exchange_token", client_secret: env.THREADS_APP_SECRET, access_token: j1.access_token })}`);
      const j2 = await leerJson(r2);
      if (!j2.access_token) throw new Error(j2?.error?.message || "no entregó token de larga duración");
      await guardarToken(env, red, { access_token: j2.access_token, usuario: String(j1.user_id || ""), expira: new Date(Date.now() + (j2.expires_in || 60 * 86400) * 1000).toISOString(), conectada: now() });
      return pagina("Threads conectado", "Ya puedes cerrar esta pestaña. La conexión se renueva sola.");
    }
    const r1 = await f("https://www.linkedin.com/oauth/v2/accessToken", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl(env, red), client_id: env.LINKEDIN_CLIENT_ID, client_secret: env.LINKEDIN_CLIENT_SECRET }),
    });
    const j1 = await leerJson(r1);
    if (!j1.access_token) throw new Error(j1.error_description || "no entregó token");
    const r2 = await f("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${j1.access_token}` } });
    const j2 = await leerJson(r2);
    if (!j2.sub) throw new Error("no se pudo leer el perfil");
    await guardarToken(env, red, { access_token: j1.access_token, sub: j2.sub, usuario: j2.name || "", expira: new Date(Date.now() + (j1.expires_in || 60 * 86400) * 1000).toISOString(), conectada: now() });
    return pagina("LinkedIn conectado", `Conectado como ${escHtml(j2.name || "tu perfil")}. Dura 60 días; te avisaremos antes de que venza.`);
  } catch (e) {
    return pagina("No se conectó", escHtml(e.message), false);
  }
}

// Threads: el token dura 60 días y se puede renovar si tiene más de 24 h. Se renueva cuando le quedan menos de 20 días.
export async function renovarThreads(env, f = fetch) {
  const t = await leerToken(env, "threads");
  if (!t?.access_token || !t.expira) return null;
  const queda = Date.parse(t.expira) - Date.now();
  if (queda <= 0 || queda > 20 * DIA || Date.now() - Date.parse(t.conectada || 0) < DIA) return null;
  const r = await f(`${TH}/refresh_access_token?${new URLSearchParams({ grant_type: "th_refresh_token", access_token: t.access_token })}`);
  const j = await leerJson(r);
  if (!j.access_token) throw new Error(j?.error?.message || "no se renovó");
  await guardarToken(env, "threads", { ...t, access_token: j.access_token, expira: new Date(Date.now() + (j.expires_in || 60 * 86400) * 1000).toISOString(), conectada: now() });
  return true;
}

// Para revisar que todo está conectado sin publicar nada.
export async function estadoPublicacion(env) {
  const dias = (t) => (t?.expira ? Math.floor((Date.parse(t.expira) - Date.now()) / DIA) : null);
  const [th, li] = await Promise.all([leerToken(env, "threads"), leerToken(env, "linkedin")]);
  const { results } = await env.HUB_DB.prepare(
    "SELECT id, formato, titulo, programada_para, publicar_intentos, publicar_error FROM piezas WHERE estado = 'programada' AND formato IN ('x','threads','linkedin') ORDER BY programada_para LIMIT 50"
  ).all();
  const avisos = [];
  if (!xListo(env)) avisos.push("X: faltan llaves en Cloudflare (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET).");
  if (!th) avisos.push("Threads: sin conectar.");
  if (!li) avisos.push("LinkedIn: sin conectar.");
  else if (dias(li) <= 7) avisos.push(`LinkedIn: la conexión vence en ${dias(li)} días; hay que reconectar.`);
  return {
    pausada: await pausada(env),
    redes: {
      x: { lista: xListo(env) },
      threads: { configurada: !!(env.THREADS_APP_ID && env.THREADS_APP_SECRET), conectada: !!th, usuario: th?.usuario || null, dias_restantes: dias(th), se_renueva_sola: true },
      linkedin: { configurada: !!(env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET), conectada: !!li, usuario: li?.usuario || null, dias_restantes: dias(li), se_renueva_sola: false },
    },
    avisos,
    en_cola: results,
  };
}

export async function pausarPublicacion(env, a = {}) {
  const pausa = a.pausa !== false && a.pausa !== "false";
  if (pausa) await env.HUB_KV.put("publicar:pausa", "1");
  else await env.HUB_KV.delete("publicar:pausa");
  return { pausada: pausa };
}
