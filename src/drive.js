// Buzón de láminas: cada lámina aprobada cae sola en Google Drive, en su propia carpeta, con su copy al lado.
//   LÁMINAS APROBADAS · Dr. Arrieta / 2026-11-06 · Dulces y cáncer de mama / lamina.png + COPY (Google Doc)
// El hub descarga la imagen exportada de Canva (enlace firmado de export-download.canva.com) y la sube a Drive.
//
// Permiso mínimo: drive.file (el hub solo ve y toca lo que él mismo crea; no puede leer el resto del Drive).
// Usa el mismo cliente OAuth de Google que YouTube (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET) y la misma
// dirección de regreso (/contenido/callback/youtube): el estado guardado en KV distingue "drive" de "youtube".
// KV: "drive:conexion" (tokens), "drive:raiz" (id de la carpeta raíz).

const ESCOPO = "https://www.googleapis.com/auth/drive.file";
const API = "https://www.googleapis.com/drive/v3";
const SUBIDA = "https://www.googleapis.com/upload/drive/v3/files";
const CARPETA = "application/vnd.google-apps.folder";
const NOMBRE_RAIZ = "LÁMINAS APROBADAS · Dr. Arrieta";
const MAX_IMAGEN = 25 * 1024 * 1024;
// Solo se descargan imágenes de los servidores de exportación de Canva (evita que el hub baje cualquier cosa).
const ORIGENES = [/^https:\/\/export-download\.canva\.com\//, /^https:\/\/[a-z0-9.-]*canva\.com\//, /^https:\/\/document-export\.canva\.com\//];

const base = (env) => env.BASE_URL || "https://sebas-contenido.sebastianarrietam.workers.dev";
const callbackUrl = (env) => `${base(env)}/contenido/callback/youtube`;
const now = () => new Date().toISOString();
async function leerJson(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
const msgError = (j, res) => j?.error?.message || j?.error_description || (typeof j?.error === "string" ? j.error : null) || `HTTP ${res.status}`;
const leerConexion = async (env) => JSON.parse((await env.HUB_KV.get("drive:conexion")) || "null");
const guardarConexion = (env, t) => env.HUB_KV.put("drive:conexion", JSON.stringify(t));

export async function enlaceDrive(env) {
  if (!env.YOUTUBE_CLIENT_ID) throw new Error("Falta YOUTUBE_CLIENT_ID en Cloudflare.");
  const state = crypto.randomUUID();
  await env.HUB_KV.put(`oauth:estado:${state}`, "drive", { expirationTtl: 900 });
  const q = new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID, redirect_uri: callbackUrl(env), response_type: "code", scope: ESCOPO, access_type: "offline", prompt: "consent select_account", state });
  return {
    red: "drive",
    enlace: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
    vence_en_minutos: 15,
    nota: "Entra con tu cuenta de Google (la del Drive del equipo). El permiso es mínimo: el hub solo ve las carpetas y archivos que él mismo crea. Si Google avisa que la app no está verificada: Configuración avanzada → Ir a Contenido Dr Arrieta (es tu propia app).",
  };
}

// Se llama desde callbackYouTube cuando el estado guardado es "drive" (el estado ya fue validado y borrado).
export async function callbackDrive(env, url, pagina, escHtml, f = fetch) {
  const code = url.searchParams.get("code");
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
    let t = { access_token: j1.access_token, refresh_token: j1.refresh_token, expira: new Date(Date.now() + (j1.expires_in || 3600) * 1000).toISOString(), conectada: now() };
    const r2 = await f(`${API}/about?fields=user(emailAddress,displayName)`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    const j2 = await leerJson(r2);
    if (!r2.ok) throw new Error(msgError(j2, r2));
    t.cuenta = j2.user?.emailAddress || null;
    await guardarConexion(env, t);
    const raiz = await carpetaRaiz(env, t, f);
    return pagina("Drive conectado", `Conectado: ${escHtml(t.cuenta || "tu cuenta")}. Las láminas aprobadas caerán en la carpeta "${escHtml(NOMBRE_RAIZ)}" (<a href="https://drive.google.com/drive/folders/${escHtml(raiz)}">abrir</a>). Ya puedes cerrar esta pestaña.`);
  } catch (e) {
    return pagina("No se conectó", escHtml(e.message), false);
  }
}

async function token(env, f) {
  const t = await leerConexion(env);
  if (!t) throw new Error("Drive no está conectado. Usa contenido_conectar_red con red 'drive'.");
  if (Date.parse(t.expira) - Date.now() > 5 * 60e3) return t;
  const r = await f("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.YOUTUBE_CLIENT_ID, client_secret: env.YOUTUBE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const j = await leerJson(r);
  if (!j.access_token) throw new Error(j.error === "invalid_grant" ? "La conexión con Drive venció o fue revocada; hay que volver a conectarla." : `No se renovó Drive: ${msgError(j, r)}`);
  const n = { ...t, access_token: j.access_token, expira: new Date(Date.now() + (j.expires_in || 3600) * 1000).toISOString() };
  await guardarConexion(env, n);
  return n;
}

async function api(f, t, url, init = {}) {
  const r = await f(url, { ...init, headers: { Authorization: `Bearer ${t.access_token}`, ...(init.headers || {}) } });
  const j = await leerJson(r);
  if (!r.ok) throw new Error(`Drive: ${msgError(j, r)}`);
  return j;
}

async function crearCarpeta(f, t, nombre, padre) {
  const j = await api(f, t, `${API}/files?fields=id&supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nombre, mimeType: CARPETA, ...(padre ? { parents: [padre] } : {}) }),
  });
  return j.id;
}

// La carpeta raíz se crea una sola vez. Si alguien la borra o la manda a la papelera, se crea otra.
async function carpetaRaiz(env, t, f) {
  const id = await env.HUB_KV.get("drive:raiz");
  if (id) {
    const r = await f(`${API}/files/${id}?fields=id,trashed&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${t.access_token}` } });
    const j = await leerJson(r);
    if (r.ok && !j.trashed) return id;
  }
  const nuevo = await crearCarpeta(f, t, NOMBRE_RAIZ);
  await env.HUB_KV.put("drive:raiz", nuevo);
  return nuevo;
}

// Subida multipart: metadatos + contenido en una sola llamada.
async function subir(f, t, meta, contenido, tipo) {
  const limite = "buzon" + crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const cabeza = enc.encode(`--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${limite}\r\nContent-Type: ${tipo}\r\n\r\n`);
  const cuerpo = typeof contenido === "string" ? enc.encode(contenido) : new Uint8Array(contenido);
  const pie = enc.encode(`\r\n--${limite}--`);
  const todo = new Uint8Array(cabeza.length + cuerpo.length + pie.length);
  todo.set(cabeza, 0);
  todo.set(cuerpo, cabeza.length);
  todo.set(pie, cabeza.length + cuerpo.length);
  return api(f, t, `${SUBIDA}?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${limite}` },
    body: todo,
  });
}

const limpiarNombre = (s) => String(s || "").replace(/[\\/:*?"<>|\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);
const extension = (tipo) => (/jpe?g/.test(tipo) ? "jpg" : /webp/.test(tipo) ? "webp" : /pdf/.test(tipo) ? "pdf" : "png");

// Busca el enlace de la imagen: campo imagen_url, o el primer enlace de exportación de Canva escrito en las notas.
export function imagenDe(a = {}, p = {}) {
  const directo = String(a.imagen_url || "").trim();
  if (directo) return directo;
  const m = String(a.notas ?? p.notas ?? "").match(/https:\/\/export-download\.canva\.com\/\S+/);
  return m ? m[0].replace(/[)\].,;]+$/, "") : null;
}

export function textoCopy(p) {
  const partes = [];
  if (p.titulo) partes.push(`LÁMINA: ${p.titulo}`, "");
  partes.push("COPY PARA PUBLICAR", "", (p.copy || "").trim() || "(sin copy)");
  if (p.referencia || p.referencia_url) partes.push("", "REFERENCIA", [p.referencia, p.referencia_url].filter(Boolean).join(" · "));
  if (p.notas && !/export-download\.canva\.com/.test(p.notas)) partes.push("", "NOTAS PARA EL EQUIPO", p.notas.trim());
  partes.push("", `Pieza ${p.id} del Centro de contenido · aprobada por el Dr. Arrieta`);
  return partes.join("\n");
}

// Deja la lámina y su copy en Drive. Devuelve { carpeta, enlace, imagen, copy }.
export async function buzonLamina(env, p, imagenUrl, f = fetch) {
  if (!imagenUrl) throw new Error("Falta el enlace de la imagen exportada de Canva (imagen_url).");
  if (!ORIGENES.some((re) => re.test(imagenUrl))) throw new Error("La imagen debe venir de una exportación de Canva (export-download.canva.com).");
  const t = await token(env, f);
  const r = await f(imagenUrl);
  if (!r.ok) throw new Error(r.status === 403 ? "El enlace de Canva venció: vuelve a exportar la lámina." : `No se pudo bajar la imagen de Canva (HTTP ${r.status}).`);
  const tipo = (r.headers.get("content-type") || "image/png").split(";")[0];
  if (!/^(image\/|application\/pdf)/.test(tipo)) throw new Error(`Canva no devolvió una imagen (${tipo}).`);
  const bytes = await r.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGEN) throw new Error("La imagen pesa más de 25 MB.");
  const raiz = await carpetaRaiz(env, t, f);
  const dia = new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);
  const nombre = limpiarNombre(`${dia} · ${p.titulo || `Pieza ${p.id}`}`);
  const carpeta = await crearCarpeta(f, t, nombre, raiz);
  const img = await subir(f, t, { name: `${limpiarNombre(p.titulo || "lamina")}.${extension(tipo)}`, parents: [carpeta] }, bytes, tipo);
  const doc = await subir(f, t, { name: `COPY · ${limpiarNombre(p.titulo || `Pieza ${p.id}`)}`, parents: [carpeta], mimeType: "application/vnd.google-apps.document" }, textoCopy(p), "text/plain; charset=UTF-8");
  return { carpeta, enlace: `https://drive.google.com/drive/folders/${carpeta}`, imagen: img.webViewLink || null, copy: doc.webViewLink || null, raiz };
}

export async function estadoDrive(env) {
  const t = await leerConexion(env);
  const raiz = await env.HUB_KV.get("drive:raiz");
  return { conectada: !!t, cuenta: t?.cuenta || null, carpeta: raiz ? `https://drive.google.com/drive/folders/${raiz}` : null };
}
