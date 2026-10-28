// Módulo Contenido: banco de ideas (guardados de X, Instagram, TikTok, Blueprint, papers)
// y piezas listas (radio, reels, LinkedIn, Threads, X, carruseles, YouTube) con su aprobación.
// Claude escribe y lee por MCP. Make escribe y lee por /contenido/* con la llave CONTENIDO_API_KEY.
import { validarParaPublicar, estadoPublicacion, pausarPublicacion, RED } from "./publicar.js";

const FUENTES = ["x", "instagram", "tiktok", "blueprint", "paper", "podcast", "noticia", "manual", "otro"];
const PRIORIDADES = ["banco", "esta_semana", "grabar_hoy"];
const ESTADOS_IDEA = ["nueva", "verificando", "verificada", "descartada", "en_produccion", "usada"];
const FORMATOS = ["radio", "reel", "reel_herida", "linkedin", "threads", "facebook", "x", "carrusel", "youtube", "otro"];
const ESTADOS_PIEZA = ["borrador", "por_aprobar", "aprobada", "enviada_equipo", "rechazada", "programada", "publicada"];
const CARRILES = ["agencia", "creador"]; // carrusel: agencia = diseñadoras proponen el gancho; creador = El Creador lo escribe completo

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
    "INSERT INTO ideas (creada, actualizada, fuente, enlace, autor, texto, tema, estado, notas, prioridad) VALUES (?, ?, ?, ?, ?, ?, ?, 'nueva', ?, ?) RETURNING *"
  )
    .bind(t, t, fuente, enlace, clip(a.autor, 200), clip(a.texto, 20000), clip(a.tema, 200), clip(a.notas, 4000), check(a.prioridad || "banco", PRIORIDADES, "prioridad"))
    .first();
  return { duplicada: false, idea: ideaOut(r) };
}

export async function listarIdeas(env, a = {}) {
  const w = [], b = [];
  if (a.estado) w.push("estado = ?"), b.push(check(a.estado, ESTADOS_IDEA, "estado"));
  if (a.fuente) w.push("fuente = ?"), b.push(check(a.fuente, FUENTES, "fuente"));
  if (a.prioridad) w.push("prioridad = ?"), b.push(check(a.prioridad, PRIORIDADES, "prioridad"));
  if (a.buscar) w.push("(texto LIKE ? OR tema LIKE ?)"), b.push(`%${a.buscar}%`, `%${a.buscar}%`);
  const sql = `SELECT id, creada, fuente, enlace, autor, tema, estado, prioridad, veredicto, substr(texto, 1, 400) AS texto FROM ideas ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY CASE prioridad WHEN 'grabar_hoy' THEN 0 WHEN 'esta_semana' THEN 1 ELSE 2 END, id DESC LIMIT ?`;
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
  if (a.prioridad != null) sets.push("prioridad = ?"), b.push(check(a.prioridad, PRIORIDADES, "prioridad"));
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
    "INSERT INTO piezas (creada, actualizada, idea_id, formato, titulo, gancho, ruta_gancho, texto, estado, notas, marca, carril, copy) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
  )
    .bind(t, t, ideaId, formato, clip(a.titulo, 300), clip(a.gancho, 1000), clip(a.ruta_gancho, 100), clip(a.texto, 30000), estado, clip(a.notas, 4000), "Dr. Arrieta", formato === "carrusel" ? check(a.carril || "creador", CARRILES, "carril") : null, clip(a.copy, 4000))
    .first();
  if (ideaId) await env.HUB_DB.prepare("UPDATE ideas SET estado = 'en_produccion', actualizada = ? WHERE id = ? AND estado IN ('nueva','verificando','verificada')").bind(t, ideaId).run();
  return piezaOut(r);
}

export async function listarPiezas(env, a = {}) {
  const w = [], b = [];
  if (a.estado) w.push("p.estado = ?"), b.push(check(a.estado, ESTADOS_PIEZA, "estado"));
  if (a.formato) w.push("p.formato = ?"), b.push(check(a.formato, FORMATOS, "formato"));
  if (a.idea_id) w.push("p.idea_id = ?"), b.push(Number(a.idea_id));
  if (a.carril) w.push("p.carril = ?"), b.push(check(a.carril, CARRILES, "carril"));
  const completo = a.completo === true || a.completo === "true" || a.completo === "1";
  const sql = `SELECT p.id, p.creada, p.actualizada, p.idea_id, p.formato, p.carril, p.titulo, p.gancho, p.ruta_gancho, p.estado, p.fecha_publicacion, p.enlace_publicado, p.programada_para, p.publicar_error, p.comentario, p.notas, p.copy,
    ${completo ? "p.texto" : "substr(p.texto, 1, 300)"} AS texto, i.enlace AS idea_enlace, i.fuente AS idea_fuente
    FROM piezas p LEFT JOIN ideas i ON i.id = p.idea_id ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY p.id DESC LIMIT ?`;
  const { results } = await env.HUB_DB.prepare(sql).bind(...b, lim(a.limite)).all();
  return results;
}

export async function actualizarPieza(env, a = {}) {
  const sets = [], b = [];
  // Programar para publicar sola: solo desde "aprobada" (nada sale sin su aprobación) y solo X, Threads o LinkedIn.
  if (a.estado === "programada" || a.programada_para != null) {
    const p = await env.HUB_DB.prepare("SELECT * FROM piezas WHERE id = ?").bind(Number(a.id)).first();
    if (!p) throw new Error(`No existe la pieza ${a.id}.`);
    const destino = a.estado || p.estado;
    if (destino === "programada" && RED[p.formato]) {
      if (!["aprobada", "programada"].includes(p.estado)) throw new Error("Solo se puede programar una pieza aprobada.");
      validarParaPublicar({ ...p, texto: a.texto ?? p.texto });
      let cuando = a.programada_para ?? p.programada_para ?? now();
      const d = new Date(cuando);
      if (isNaN(d)) throw new Error(`Fecha inválida: ${cuando}`);
      sets.push("programada_para = ?", "publicar_intentos = 0", "publicar_error = NULL"), b.push(d.toISOString());
    } else if (a.programada_para != null) {
      const d = new Date(a.programada_para);
      if (isNaN(d)) throw new Error(`Fecha inválida: ${a.programada_para}`);
      sets.push("programada_para = ?"), b.push(d.toISOString());
    }
  }
  // Si sale de la cola (vuelve a aprobada, se rechaza, etc.), se borra la hora programada.
  if (a.estado != null && !["programada", "publicada"].includes(a.estado) && a.programada_para == null) sets.push("programada_para = NULL");
  if (a.estado != null) sets.push("estado = ?"), b.push(check(a.estado, ESTADOS_PIEZA, "estado"));
  if (a.texto != null) sets.push("texto = ?"), b.push(clip(a.texto, 30000));
  if (a.gancho != null) sets.push("gancho = ?"), b.push(clip(a.gancho, 1000));
  if (a.titulo != null) sets.push("titulo = ?"), b.push(clip(a.titulo, 300));
  if (a.carril != null) sets.push("carril = ?"), b.push(check(a.carril, CARRILES, "carril"));
  if (a.copy != null) sets.push("copy = ?"), b.push(clip(a.copy, 4000));
  if (a.comentario != null) sets.push("comentario = ?"), b.push(clip(a.comentario, 4000));
  if (a.notas != null) sets.push("notas = ?"), b.push(clip(a.notas, 4000));
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
  const [i, p, hoy] = await Promise.all([
    env.HUB_DB.prepare("SELECT estado, COUNT(*) AS n FROM ideas GROUP BY estado").all(),
    env.HUB_DB.prepare("SELECT formato, estado, COUNT(*) AS n FROM piezas GROUP BY formato, estado").all(),
    env.HUB_DB.prepare("SELECT id, tema, enlace, creada FROM ideas WHERE prioridad = 'grabar_hoy' AND estado NOT IN ('usada','descartada') ORDER BY id DESC").all(),
  ]);
  const ideas = Object.fromEntries(i.results.map((r) => [r.estado, r.n]));
  const piezas = {};
  for (const r of p.results) (piezas[r.estado] ||= {})[r.formato] = r.n;
  return { grabar_hoy: hoy.results, ideas, piezas };
}

// ---------- Filas listas para las hojas de carruseles ----------
// carril "agencia"  -> Excel de las diseñadoras "CONTENT RRSS - SEBAS ARRIETA" (hoja del mes).
//   Va la materia prima SIN gancho: ellas proponen el gancho y la idea visual.
//   Columnas: IDEA DE CONTENIDO | INFORMACIÓN | REFE | MARCA | ARTES | STATUS | ... | FECHA Y HORA
// carril "creador"  -> hoja propia "CARRUSELES EL CREADOR": carrusel completo lámina por lámina.
const MESES = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
export async function filasExcel(env, a = {}) {
  const carril = check(a.carril || "agencia", CARRILES, "carril");
  const estado = check(a.estado || "aprobada", ESTADOS_PIEZA, "estado");
  const { results } = await env.HUB_DB.prepare(
    `SELECT p.*, i.enlace AS idea_enlace, i.estudio AS idea_estudio FROM piezas p LEFT JOIN ideas i ON i.id = p.idea_id
     WHERE p.estado = ? AND p.formato = 'carrusel' AND p.carril = ? ORDER BY p.id LIMIT ?`
  ).bind(estado, carril, lim(a.limite, 20, 100)).all();
  const lima = new Date(Date.now() - 5 * 3600e3);
  return results.map((p) => {
    const est = parse(p.idea_estudio);
    const refe = est && typeof est === "object" ? [est.cita, est.enlace].filter(Boolean).join(" ") : est || "";
    const f = p.fecha_publicacion ? new Date(p.fecha_publicacion) : null;
    const fecha = f ? `${String(f.getUTCDate()).padStart(2, "0")}/${String(f.getUTCMonth() + 1).padStart(2, "0")}` : "";
    if (carril === "agencia")
      return {
        pieza_id: p.id,
        hoja: MESES[(f || lima).getUTCMonth()],
        idea_de_contenido: p.texto,
        informacion: p.idea_enlace || "",
        refe,
        marca: "Dr. Arrieta",
        artes: String(p.titulo || "").toUpperCase(),
        status: "APROBACIÓN",
        fecha,
      };
    return {
      pieza_id: p.id,
      fecha,
      tema: String(p.titulo || "").toUpperCase(),
      gancho: p.gancho || "",
      ruta_gancho: p.ruta_gancho || "",
      laminas: p.texto,
      copy: p.copy || "",
      fuente: p.idea_enlace || "",
      referencia: refe,
      status: "LISTO PARA DISEÑO",
    };
  });
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
    if (path === "/contenido/excel" && req.method === "GET") return Response.json(await filasExcel(env, q));
    if (path === "/contenido/publicacion" && req.method === "GET") return Response.json(await estadoPublicacion(env));
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
        prioridad: { type: "string", enum: PRIORIDADES, description: "grabar_hoy solo para novedad que debe salir hoy sí o sí" },
        notas: { type: "string" },
      },
    },
    run: (env, a) => registrarIdea(env, a),
  },
  {
    name: "contenido_listar_ideas",
    description: "Lista ideas del banco: primero las de grabar hoy, luego las de esta semana, luego las más nuevas. Filtra por prioridad, estado (nueva, verificando, verificada, descartada, en_produccion, usada), fuente o texto.",
    inputSchema: {
      type: "object",
      properties: {
        estado: { type: "string", enum: ESTADOS_IDEA },
        fuente: { type: "string", enum: FUENTES },
        prioridad: { type: "string", enum: PRIORIDADES },
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
        prioridad: { type: "string", enum: PRIORIDADES },
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
    description: "Guarda una pieza escrita (guion de radio, reel de 30 s, reel herida abierta, LinkedIn, Threads, Facebook, X, carrusel, YouTube) ligada a su idea. Queda 'por_aprobar' salvo que se indique otro estado. Para carrusel carril 'agencia': titulo = tema corto, texto = materia prima (por qué importa, datos verificados, qué NO decir), SIN gancho. Carril 'creador': gancho = lámina 1, texto = láminas numeradas, copy = caption.",
    inputSchema: {
      type: "object",
      properties: {
        idea_id: { type: "number" },
        formato: { type: "string", enum: FORMATOS },
        titulo: { type: "string" },
        gancho: { type: "string" },
        ruta_gancho: { type: "string", description: "shock, comparativa, emocional, polémico, mito vs realidad, cultural…" },
        carril: { type: "string", enum: CARRILES, description: "Solo carrusel. agencia: materia prima sin gancho para las diseñadoras. creador: carrusel completo de El Creador." },
        copy: { type: "string", description: "Texto de la publicación (caption)" },
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
    description: "Cambia una pieza: aprobarla o rechazarla (estado + comentario), corregir texto o gancho, o marcarla programada/publicada con fecha, enlace y métricas. Para X, Threads y LinkedIn, estado 'programada' + programada_para hace que se publique SOLA a esa hora: hazlo únicamente cuando Sebastián lo pida explícitamente. Para sacarla de la cola, vuelve a 'aprobada'.",
    inputSchema: {
      type: "object",
      properties: {
        ...idProp,
        estado: { type: "string", enum: ESTADOS_PIEZA },
        texto: { type: "string" },
        gancho: { type: "string" },
        titulo: { type: "string" },
        comentario: { type: "string", description: "Comentario de aprobación o rechazo" },
        notas: { type: "string", description: "Notas de cabina y producción" },
        fecha_publicacion: { type: "string", description: "ISO 8601" },
        programada_para: { type: "string", description: "ISO 8601: cuándo se publica sola (X, Threads, LinkedIn). Con estado 'programada'; sin fecha = en los próximos 5 minutos. Solo desde 'aprobada'." },
        enlace_publicado: { type: "string" },
        metricas: { type: "object" },
      },
      required: ["id"],
    },
    run: (env, a) => actualizarPieza(env, a),
  },
  {
    name: "contenido_publicacion_estado",
    description: "Revisa la publicación automática sin publicar nada: si está en pausa, si los secretos están cargados, qué cuentas tiene conectadas Ayrshare y qué piezas están en cola.",
    inputSchema: { type: "object", properties: {} },
    run: (env) => estadoPublicacion(env),
  },
  {
    name: "contenido_pausar_publicacion",
    description: "Freno de emergencia: pausa (pausa=true) o reanuda (pausa=false) toda la publicación automática. Las piezas programadas esperan en cola.",
    inputSchema: { type: "object", properties: { pausa: { type: "boolean" } }, required: ["pausa"] },
    run: (env, a) => pausarPublicacion(env, a),
  },
  {
    name: "contenido_resumen",
    description: "Tablero rápido: novedades marcadas para grabar hoy, cuántas ideas hay por estado y cuántas piezas por estado y formato.",
    inputSchema: { type: "object", properties: {} },
    run: (env) => contenidoResumen(env),
  },
];
