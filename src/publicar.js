// Publicación automática en X, Threads y LinkedIn a través de Ayrshare.
//
// Regla de oro: solo se publica lo que Sebastián aprobó y luego programó.
//   aprobada → (él pulsa "Programar" o "Publicar ahora" en la Mesa) → programada → publicada
// Cada 5 minutos el cron toma las piezas programadas cuya hora ya llegó y las publica.
// Si algo falla 3 veces, la pieza vuelve a "aprobada" con el error a la vista, y no se reintenta sola.
//
// Secretos (solo en Cloudflare): AYRSHARE_API_KEY, X_API_KEY, X_API_SECRET.
// Freno de emergencia: KV "publicar:pausa" = "1" (herramienta contenido_pausar_publicacion).

export const RED = { x: "twitter", threads: "threads", linkedin: "linkedin" };
export const LIMITE = { x: 280, threads: 500, linkedin: 3000 };
const AYRSHARE = "https://api.ayrshare.com/api";
const MAX_INTENTOS = 3;
const now = () => new Date().toISOString();

// X cuenta los enlaces como 23 caracteres y algunos símbolos como 2; aquí usamos un conteo prudente.
export function largo(formato, texto) {
  const t = String(texto || "");
  if (formato !== "x") return [...t].length;
  return [...t.replace(/https?:\/\/\S+/g, "x".repeat(23))].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2fff ? 2 : 1), 0);
}

// Valida una pieza antes de dejarla programada. Lanza error con un mensaje que se entiende en la Mesa.
export function validarParaPublicar(p) {
  if (!RED[p.formato]) throw new Error(`Solo se publica sola en X, Threads y LinkedIn (esta pieza es ${p.formato}).`);
  const texto = String(p.texto || "").trim();
  if (!texto) throw new Error("La pieza no tiene texto para publicar.");
  const n = largo(p.formato, texto);
  if (n > LIMITE[p.formato]) throw new Error(`Muy larga para ${p.formato}: ${n} caracteres (máximo ${LIMITE[p.formato]}).`);
  return texto;
}

function cabeceras(env, formato) {
  const h = { Authorization: `Bearer ${env.AYRSHARE_API_KEY}`, "Content-Type": "application/json" };
  if (formato === "x") {
    h["X-Twitter-OAuth1-Api-Key"] = env.X_API_KEY || "";
    h["X-Twitter-OAuth1-Api-Secret"] = env.X_API_SECRET || "";
  }
  return h;
}

async function enviar(env, p, fetchImpl = fetch) {
  const texto = validarParaPublicar(p);
  if (p.formato === "x" && !(env.X_API_KEY && env.X_API_SECRET)) throw new Error("Faltan X_API_KEY y X_API_SECRET en Cloudflare.");
  const res = await fetchImpl(`${AYRSHARE}/post`, {
    method: "POST",
    headers: cabeceras(env, p.formato),
    body: JSON.stringify({ post: texto, platforms: [RED[p.formato]], idempotencyKey: `pieza-${p.id}`, notes: `Mesa de control · pieza ${p.id}` }),
  });
  let j = {};
  try {
    j = await res.json();
  } catch {}
  const r = (j.postIds || []).find((x) => x.platform === RED[p.formato]) || (j.postIds || [])[0];
  if (res.ok && j.status === "success" && r && r.status === "success") return { ayrshare_id: j.id || null, url: r.postUrl || null };
  const err = (j.errors || [])[0];
  throw new Error(err ? `${err.message || "error"}${err.code ? ` (código ${err.code})` : ""}` : `Ayrshare respondió ${res.status}`);
}

export async function pausada(env) {
  return (await env.HUB_KV.get("publicar:pausa")) === "1";
}

// Lo que corre el cron cada 5 minutos.
export async function publicarPendientes(env, { fetchImpl = fetch, limite = 3 } = {}) {
  if (!env.AYRSHARE_API_KEY) return { omitido: "Falta AYRSHARE_API_KEY" };
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
      const r = await enviar(env, p, fetchImpl);
      const t = now();
      await env.HUB_DB.prepare(
        "UPDATE piezas SET estado = 'publicada', fecha_publicacion = ?, enlace_publicado = ?, ayrshare_id = ?, publicar_error = NULL, actualizada = ? WHERE id = ?"
      ).bind(t, r.url, r.ayrshare_id, t, p.id).run();
      if (p.idea_id) await env.HUB_DB.prepare("UPDATE ideas SET estado = 'usada', actualizada = ? WHERE id = ?").bind(t, p.idea_id).run();
      out.push({ id: p.id, formato: p.formato, publicada: true, enlace: r.url });
    } catch (e) {
      const intentos = p.publicar_intentos + 1;
      const agotado = intentos >= MAX_INTENTOS;
      await env.HUB_DB.prepare(
        `UPDATE piezas SET publicar_error = ?, actualizada = ?${agotado ? ", estado = 'aprobada', comentario = ?" : ""} WHERE id = ?`
      ).bind(...[String(e.message).slice(0, 1000), now(), ...(agotado ? [`No se pudo publicar en ${p.formato}: ${e.message}`.slice(0, 1000)] : []), p.id]).run();
      out.push({ id: p.id, formato: p.formato, publicada: false, error: e.message, intentos, devuelta_a_aprobada: agotado });
    }
  }
  return { revisadas: results.length, resultados: out };
}

// Para revisar que todo está conectado sin publicar nada.
export async function estadoPublicacion(env, fetchImpl = fetch) {
  const out = {
    pausada: await pausada(env),
    secretos: { AYRSHARE_API_KEY: !!env.AYRSHARE_API_KEY, X_API_KEY: !!env.X_API_KEY, X_API_SECRET: !!env.X_API_SECRET },
  };
  const { results } = await env.HUB_DB.prepare(
    "SELECT id, formato, titulo, programada_para, publicar_intentos, publicar_error FROM piezas WHERE estado = 'programada' ORDER BY programada_para LIMIT 50"
  ).all();
  out.en_cola = results;
  if (env.AYRSHARE_API_KEY) {
    try {
      const r = await fetchImpl(`${AYRSHARE}/user`, { headers: cabeceras(env, "x") });
      const j = await r.json();
      out.cuentas_conectadas = j.activeSocialAccounts || [];
      if (!r.ok) out.error_ayrshare = j.message || `HTTP ${r.status}`;
    } catch (e) {
      out.error_ayrshare = e.message;
    }
  }
  return out;
}

export async function pausarPublicacion(env, a = {}) {
  const pausa = a.pausa !== false && a.pausa !== "false";
  if (pausa) await env.HUB_KV.put("publicar:pausa", "1");
  else await env.HUB_KV.delete("publicar:pausa");
  return { pausada: pausa };
}
