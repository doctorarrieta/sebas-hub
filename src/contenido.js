// Módulo Contenido: banco de ideas (guardados de X, Instagram, TikTok, Blueprint, papers)
// y piezas listas (radio, reels, LinkedIn, Threads, X, carruseles, YouTube) con su aprobación.
// Claude escribe y lee por MCP. Make escribe y lee por /contenido/* con la llave CONTENIDO_API_KEY.

const FUENTES = ["x", "instagram", "tiktok", "blueprint", "paper", "podcast", "manual", "otro"];
const ESTADOS_IDEA = ["nueva", "verificando", "verificada", "descartada", "en_produccion", "usada"];
const FORMATOS = ["radio", "reel", "reel_herida", "linkedin", "threads", "x", "carrusel", "youtube", "otro"];
const ESTADOS_PIEZA = ["borrador", "por_aprobar", "aprobada", "rechazada", "programada", "publicada"];

const now = () => new Date().toISOString();
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));
const lim = (n, d = 20, max = 200) => Math.min(Math.max(Number(n) || d, 1), max);
const json = (v) => (v == null ? null : typeof v === "string" ? v : JSON.stringify(v));
const parse = (s) => {
  if (s == null) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};
function check(val, list, campo) {
  if (val != null && !list.includes(val)) throw new Error(`${campo} inválido: "${val}". Usa uno de: ${list.join(", ")}`);
  return val;
}
const ideaOut = (r) => r && { ...r, estudio: parse(r.estudio) };
const piezaOut = (r) => r && { ...r, metricas: parse(r.metricas) };

// ---------- Ideas ----------
export async function registrarIdea(env, a = {}) {
  const fuente = check(a.fuente || "manual", FUENTES, "fuente");
  if (!a.texto && !a.enlace) throw new Error("Falta texto o enlace.");
  const enlace = clip(a.enlace, 1000);
  if (enlace) {
    const ya = await env.HUB_DB.prepare("SELECT * FROM ideas WHERE enlace = ?").bind(enlace).first();
    if (ya) return { duplicada: true, idea: ideaOut(ya) };
  }
  const t = now();
  const r = await env.HUB_DB.prepare(
    "INSERT INTO ideas (creada, actualizada, fuente, enlace, autor, texto, tema, estado, notas) VALUES (?, ?, ?, ?, ?, ?, ?, 'nueva', ?) RETURNING *"
  )
    .bind(t, t, fuente, enlace, clip(a.autor, 200), clip(a.texto, 20000), clip(a.tema, 200), clip(a.notas, 4000))
    .first();
  return { duplicada: false, idea: ideaOut(r) };
}

export async function listarIdeas(env, a = {}) {
  const w = [], b = [];
  if (a.estado) w.push("estado = ?"), b.push(check(a.estado, ESTADOS_IDEA, "estado"));
  if (a.fuente) w.push("fuente = ?"), b.push(check(a.fuente, FUENTES, "fuente"));
  if (a.buscar) w.push("(texto LIKE ? OR tema LIKE ?)"), b.push(`%${a.buscar}%`, `%${a.buscar}%`);
  const sql = `SELECT id, creada, fuente, enlace, autor, tema, estado, veredicto, substr(texto, 1, 400) AS texto FROM ideas ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  const { results } = await env.HUB_DB.prepare(sql).bind(...b, lim(a.limite)).all();
  return results;
}

export async function verIdea(env, a = {}) {
  const idea = await env.HUB_DB.prepare("SELECT * FROM ideas WHERE id = ?").bind(Number(a.id)).first();
  if (!idea) throw new Error(`No existe la idea ${a.id}.`);
  const { results } = await env.HUB_DB.prepare("SELECT * FROM piezas WHERE idea_id = ? ORDER BY id").bind(idea.id).all();
  return { idea: ideaOut(idea), piezas: results.map(piezaOut) };
}

export async function actualizarIdea(env, a = {}) {
  const sets = [], b = [];
  if (a.estado != null) sets.push("estado = ?"), b.push(check(a.estado, ESTADOS_IDEA, "estado"));
  if (a.tema != null) sets.push("tema = ?"), b.push(clip(a.tema, 200));
  if (a.veredicto != null) sets.push("veredicto = ?"), b.push(clip(a.veredicto, 4000));
  if (a.estudio != null) sets.push("estudio = ?"), b.push(json(a.estudio));
  if (a.texto != null) sets.push("texto = ?"), b.push(clip(a.texto, 20000));
  if (a.notas != null) sets.push("notas = ?"), b.push(clip(a.notas, 4000));
  if (!sets.length) throw new Error("No hay nada que actualizar.");
  const r = await env.HUB_DB.prepare(`UPDATE ideas SET ${sets.join(", ")}, actualizada = ? WHERE id = ? RETURNING *`)
    .bind(...b, now(), Number(a.id))
    .first();
  if (!r) throw new Error(`No existe la idea ${a.id}.`);
  return ideaOut(r);
}

// ---------- Piezas ----------
export async function registrarPieza(env, a = {}) {
  const formato = check(a.formato, FORMATOS, "formato");
  if (!formato) throw new Error("Falta formato.");
  if (!a.texto) throw new Error("Falta texto.");
  const estado = check(a.estado || "por_aprobar", ESTADOS_PIEZA, "estado");
  const ideaId = a.idea_id != null ? Number(a.idea_id) : null;
  if (ideaId && !(await env.HUB_DB.prepare("SELECT id FROM ideas WHERE id = ?").bind(ideaId).first()))
    throw new Error(`No existe la idea ${ideaId}.`);
  const t = now();
  const r = await env.HUB_DB.prepare(
    "INSERT INTO piezas (creada, actualizada, idea_id, formato, titulo, gancho, ruta_gancho, texto, estado, notas) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
  )
    .bind(t, t, ideaId, formato, clip(a.titulo, 300), clip(a.gancho, 1000), clip(a.ruta_gancho, 100), clip(a.texto, 30000), estado, clip(a.notas, 4000))
    .first();
  if (ideaId) await env.HUB_DB.prepare("UPDATE ideas SET estado = 'en_produccion', actualizada = ? WHERE id = ? AND estado IN ('nueva','verificando','verificada')").bind(t, ideaId).run();
  return piezaOut(r);
}

export async function listarPiezas(env, a = {}) {
  const w = [], b = [];
  if (a.estado) w.push("p.estado = ?"), b.push(check(a.estado, ESTADOS_PIEZA, "estado"));
  if (a.formato) w.push("p.formato = ?"), b.push(check(a.formato, FORMATOS, "formato"));
  if (a.idea_id) w.push("p.idea_id = ?"), b.push(Number(a.idea_id));
  const completo = a.completo === true || a.completo === "true" || a.completo === "1";
  const sql = `SELECT p.id, p.creada, p.actualizada, p.idea_id, p.formato, p.titulo, p.gancho, p.ruta_gancho, p.estado, p.fecha_publicacion, p.enlace_publicado, p.comentario,
    ${completo ? "p.texto" : "substr(p.texto, 1, 300)"} AS texto, i.enlace AS idea_enlace, i.fuente AS idea_fuente
    FROM piezas p LEFT JOIN ideas i ON i.id = p.idea_id ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY p.id DESC LIMIT ?`;
  const { results } = await env.HUB_DB.prepare(sql).bind(...b, lim(a.limite)).all();
  return results;
}

export async function actualizarPieza(env, a = {}) {
  const sets = [], b = [];
  if (a.estado != null) sets.push("estado = ?"), b.push(check(a.estado, ESTADOS_PIEZA, "estado"));
  if (a.texto != null) sets.push("texto = ?"), b.push(clip(a.texto, 30000));
  if (a.gancho != null) sets.push("gancho = ?"), b.push(clip(a.gancho, 1000));
  if (a.titulo != null) sets.push("titulo = ?"), b.push(clip(a.titulo, 300));
  if (a.comentario != null) sets.push("comentario = ?"), b.push(clip(a.comentario, 4000));
  if (a.fecha_publicacion != null) sets.push("fecha_publicacion = ?"), b.push(clip(a.fecha_publicacion, 40));
  if (a.enlace_publicado != null) sets.push("enlace_publicado = ?"), b.push(clip(a.enlace_publicado, 1000));
  if (a.metricas != null) sets.push("metricas = ?"), b.push(json(a.metricas));
  if (!sets.length) throw new Error("No hay nada que actualizar.");
  const r = await env.HUB_DB.prepare(`UPDATE piezas SET ${sets.join(", ")}, actualizada = ? WHERE id = ? RETURNING *`)
    .bind(...b, now(), Number(a.id))
    .first();
  if (!r) throw new Error(`No existe la pieza ${a.id}.`);
  if (r.estado === "publicada" && r.idea_id)
    await env.HUB_DB.prepare("UPDATE ideas SET estado = 'usada', actualizada = ? WHERE id = ?").bind(now(), r.idea_id).run();
  return piezaOut(r);
}

export async function contenidoResumen(env) {
  const [i, p] = await Promise.all([
    env.HUB_DB.prepare("SELECT estado, COUNT(*) AS n FROM ideas GROUP BY estado").all(),
    env.HUB_DB.prepare("SELECT formato, estado, COUNT(*) AS n FROM piezas GROUP BY formato, estado").all(),
  ]);
  const ideas = Object.fromEntries(i.results.map((r) => [r.estado, r.n]));
  const piezas = {};
  for (const r of p.results) (piezas[r.estado] ||= {})[r.formato] = r.n;
  return { ideas, piezas };
}

// ---------- Entrada HTTP para Make (llave CONTENIDO_API_KEY) ----------
async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a || ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b || ""))),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0 && !!b;
}

export async function contenidoHttp(req, env, url) {
  const auth = req.headers.get("authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-api-key");
  if (!(await safeEqual(key, env.CONTENIDO_API_KEY))) return Response.json({ error: "No autorizado" }, { status: 401 });
  const q = Object.fromEntries(url.searchParams);
  const body = async () => {
    if (Number(req.headers.get("content-length") || 0) > 2 * 1024 * 1024) throw new Error("Demasiado grande");
    return req.json();
  };
  try {
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/contenido/ideas" && req.method === "POST") {
      const b = await body();
      const lista = Array.isArray(b) ? b : Array.isArray(b?.ideas) ? b.ideas : [b];
      const out = [];
      for (const it of lista.slice(0, 100)) out.push(await registrarIdea(env, it).catch((e) => ({ error: e.message })));
      return Response.json({ ok: true, resultados: out });
    }
    if (path === "/contenido/ideas" && req.method === "GET") return Response.json(await listarIdeas(env, q));
    if (path === "/contenido/piezas" && req.method === "GET") return Response.json(await listarPiezas(env, { completo: true, ...q }));
    const m = path.match(/^\/contenido\/piezas\/(\d+)$/);
    if (m && req.method === "POST") return Response.json(await actualizarPieza(env, { ...(await body()), id: Number(m[1]) }));
    if (path === "/contenido/resumen" && req.method === "GET") return Response.json(await contenidoResumen(env));
    return Response.json({ error: "Ruta no encontrada" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 400 });
  }
}

// ---------- Herramientas MCP ----------
const idProp = { id: { type: "number", description: "Número de la idea o pieza" } };

export const contenidoTools = [
  {
    name: "contenido_registrar_idea",
    description: "Guarda una idea cruda en el banco (un guardado de X, Instagram, TikTok, Blueprint, un paper o una idea propia). Si el enlace ya existe, no la duplica y devuelve la existente.",
    inputSchema: {
      type: "object",
      properties: {
        fuente: { type: "string", enum: FUENTES },
        enlace: { type: "string", description: "Link original (tweet, reel, paper)" },
        texto: { type: "string", description: "Texto, transcripción o resumen del contenido" },
        autor: { type: "string", description: "Cuenta o investigador de origen" },
        tema: { type: "string" },
        notas: { type: "string" },
      },
    },
    run: (env, a) => registrarIdea(env, a),
  },
  {
    name: "contenido_listar_ideas",
    description: "Lista ideas del banco, las más nuevas primero. Filtra por estado (nueva, verificando, verificada, descartada, en_produccion, usada), fuente o texto.",
    inputSchema: {
      type: "object",
      properties: {
        estado: { type: "string", enum: ESTADOS_IDEA },
        fuente: { type: "string", enum: FUENTES },
        buscar: { type: "string", description: "Palabra a buscar en texto o tema" },
        limite: { type: "number", description: "20 por defecto, tope 200" },
      },
    },
    run: (env, a) => listarIdeas(env, a),
  },
  {
    name: "contenido_ver_idea",
    description: "Muestra una idea completa (texto, verificación del estudio, veredicto) con todas las piezas creadas a partir de ella.",
    inputSchema: { type: "object", properties: idProp, required: ["id"] },
    run: (env, a) => verIdea(env, a),
  },
  {
    name: "contenido_actualizar_idea",
    description: "Actualiza una idea: estado, tema, veredicto de la verificación, datos del estudio verificado (objeto libre: diseño, n, resultado, enlace, dudas), texto o notas.",
    inputSchema: {
      type: "object",
      properties: {
        ...idProp,
        estado: { type: "string", enum: ESTADOS_IDEA },
        tema: { type: "string" },
        veredicto: { type: "string" },
        estudio: { type: "object", description: "Datos del estudio verificado" },
        texto: { type: "string" },
        notas: { type: "string" },
      },
      required: ["id"],
    },
    run: (env, a) => actualizarIdea(env, a),
  },
  {
    name: "contenido_registrar_pieza",
    description: "Guarda una pieza escrita (guion de radio, reel, reel herida abierta, LinkedIn, Threads, X, carrusel, YouTube) ligada a su idea. Queda 'por_aprobar' salvo que se indique otro estado.",
    inputSchema: {
      type: "object",
      properties: {
        idea_id: { type: "number" },
        formato: { type: "string", enum: FORMATOS },
        titulo: { type: "string" },
        gancho: { type: "string" },
        ruta_gancho: { type: "string", description: "shock, comparativa, emocional, polémico, mito vs realidad, cultural…" },
        texto: { type: "string" },
        estado: { type: "string", enum: ESTADOS_PIEZA },
        notas: { type: "string" },
      },
      required: ["formato", "texto"],
    },
    run: (env, a) => registrarPieza(env, a),
  },
  {
    name: "contenido_listar_piezas",
    description: "Lista piezas por estado (borrador, por_aprobar, aprobada, rechazada, programada, publicada) y formato. Usa estado 'por_aprobar' para ver lo pendiente de aprobación.",
    inputSchema: {
      type: "object",
      properties: {
        estado: { type: "string", enum: ESTADOS_PIEZA },
        formato: { type: "string", enum: FORMATOS },
        idea_id: { type: "number" },
        completo: { type: "boolean", description: "true para traer el texto completo" },
        limite: { type: "number" },
      },
    },
    run: (env, a) => listarPiezas(env, a),
  },
  {
    name: "contenido_actualizar_pieza",
    description: "Cambia una pieza: aprobarla o rechazarla (estado + comentario), corregir texto o gancho, o marcarla programada/publicada con fecha, enlace y métricas.",
    inputSchema: {
      type: "object",
      properties: {
        ...idProp,
        estado: { type: "string", enum: ESTADOS_PIEZA },
        texto: { type: "string" },
        gancho: { type: "string" },
        titulo: { type: "string" },
        comentario: { type: "string", description: "Comentario de aprobación o rechazo" },
        fecha_publicacion: { type: "string", description: "ISO 8601" },
        enlace_publicado: { type: "string" },
        metricas: { type: "object" },
      },
      required: ["id"],
    },
    run: (env, a) => actualizarPieza(env, a),
  },
  {
    name: "contenido_resumen",
    description: "Tablero rápido: cuántas ideas hay por estado y cuántas piezas por estado y formato.",
    inputSchema: { type: "object", properties: {} },
    run: (env) => contenidoResumen(env),
  },
];
