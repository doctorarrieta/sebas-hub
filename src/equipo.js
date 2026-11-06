// Tablero del equipo: página pública de solo lectura con el rendimiento de los videos.
// Se abre con un enlace secreto (/equipo/<código>), sin cuenta ni contraseña. Nada se puede aprobar ni publicar desde ahí.
// La revisión diaria guarda los datos con la herramienta contenido_guardar_rendimiento.
import paginaEquipo from "./equipo-pagina.js";

const COLECCIONES = ["videos", "dias", "aprendizajes"];
const now = () => new Date().toISOString();
const CLAVE = "equipo:codigo";

export async function guardarRendimiento(env, a = {}) {
  const items = Array.isArray(a.items) ? a.items : [a];
  if (!items.length || items.length > 50) throw new Error("Envía entre 1 y 50 elementos en items.");
  const out = [];
  for (const it of items) {
    if (!COLECCIONES.includes(it.coleccion)) throw new Error(`coleccion inválida: ${it.coleccion}. Usa videos, dias o aprendizajes.`);
    const id = String(it.id || "").trim();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw new Error(`id inválido: "${id}" (solo letras, números, punto, guion y guion bajo).`);
    const datos = it.datos && typeof it.datos === "object" ? it.datos : null;
    if (!datos) throw new Error(`Faltan los datos de ${it.coleccion}/${id}.`);
    const json = JSON.stringify(datos);
    if (json.length > 20000) throw new Error(`${it.coleccion}/${id} es demasiado grande.`);
    const fecha = String(datos.fecha || "").slice(0, 10) || null;
    await env.HUB_DB.prepare(
      "INSERT INTO rendimiento (coleccion, id, fecha, datos, actualizada) VALUES (?, ?, ?, ?, ?) ON CONFLICT(coleccion, id) DO UPDATE SET fecha = excluded.fecha, datos = excluded.datos, actualizada = excluded.actualizada"
    ).bind(it.coleccion, id, fecha, json, now()).run();
    out.push(`${it.coleccion}/${id}`);
  }
  return { guardados: out.length, elementos: out };
}

export async function leerRendimiento(env) {
  const q = (c, lim) =>
    env.HUB_DB.prepare("SELECT id, datos, actualizada FROM rendimiento WHERE coleccion = ? ORDER BY fecha DESC, actualizada DESC LIMIT ?").bind(c, lim).all();
  const [v, d, a, g] = await Promise.all([q("videos", 400), q("dias", 30), q("aprendizajes", 300), guionesAprobados(env)]);
  const map = (r) => r.results.map((x) => ({ id: x.id, ...JSON.parse(x.datos) }));
  const ultima = [...v.results, ...d.results, ...a.results].map((x) => x.actualizada).sort().pop() || null;
  return { videos: map(v), dias: map(d), aprendizajes: map(a), guiones: g, actualizado: ultima };
}

// Guiones que el equipo necesita para grabar, editar o diseñar: solo los ya aprobados por el doctor.
// (X y Threads no van: se publican solos desde el hub.)
export const FORMATOS_EQUIPO = ["reel", "reel_herida", "radio", "youtube", "carrusel", "facebook", "linkedin", "otro"];
export async function guionesAprobados(env) {
  const marcas = FORMATOS_EQUIPO.map(() => "?").join(",");
  const { results } = await env.HUB_DB.prepare(
    `SELECT id, formato, carril, titulo, gancho, ruta_gancho, texto, copy, referencia, referencia_url, estado, actualizada, fecha_publicacion, enlace_publicado, drive_enlace
     FROM piezas WHERE estado IN ('aprobada','enviada_equipo','programada','publicada') AND formato IN (${marcas})
     ORDER BY CASE estado WHEN 'aprobada' THEN 0 WHEN 'enviada_equipo' THEN 1 WHEN 'programada' THEN 2 ELSE 3 END, actualizada DESC LIMIT 300`
  ).bind(...FORMATOS_EQUIPO).all();
  return results;
}

async function codigo(env) {
  let c = await env.HUB_KV.get(CLAVE);
  if (!c) {
    c = crypto.randomUUID().replace(/-/g, "");
    await env.HUB_KV.put(CLAVE, c);
  }
  return c;
}

export async function enlaceEquipo(env, a = {}) {
  if (a.renovar === true || a.renovar === "true") await env.HUB_KV.put(CLAVE, crypto.randomUUID().replace(/-/g, ""));
  const base = env.BASE_URL || "https://sebas-contenido.sebastianarrietam.workers.dev";
  return { enlace: `${base}/equipo/${await codigo(env)}`, nota: a.renovar ? "Enlace nuevo: el anterior ya no funciona." : "Cualquiera con este enlace ve el tablero (solo lectura)." };
}

const H = { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" };

export async function equipoHttp(req, env, url) {
  const m = url.pathname.match(/^\/equipo\/([a-f0-9]{32})(\/datos)?\/?$/);
  const c = await env.HUB_KV.get(CLAVE);
  if (!m || !c || m[1] !== c || req.method !== "GET")
    return new Response("Este enlace no existe o ya no es válido. Pide el enlace actualizado.", { status: 404, headers: { ...H, "content-type": "text/plain; charset=utf-8" } });
  if (m[2]) return Response.json(await leerRendimiento(env), { headers: H });
  return new Response(paginaEquipo, { headers: { ...H, "content-type": "text/html; charset=utf-8" } });
}
