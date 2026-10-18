// Módulo Apple Salud: recibe los envíos de la app "Health Auto Export" (REST API)
// y los guarda por día en D1. Incluye lo que otras apps escriben en Apple Salud
// (MyFitnessPal, Withings, faja caminadora, etc.).

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

// "2026-10-14 00:00:00 -0500" -> "2026-10-14" en hora de Lima
function toLimaDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})?/);
  const d = m ? new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] || "00"}`) : new Date(s);
  if (isNaN(d)) return String(s).slice(0, 10);
  return new Date(d.getTime() - 5 * 3600e3).toISOString().slice(0, 10);
}

const AVG_METRICS = /audio|exposure|heart_rate|variability|oxygen|body_fat|body_mass|weight|bmi|lean|temperature|respiratory|vo2|speed|length|asymmetry|percentage|pressure|glucose/;

export async function appleIngest(req, env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const auth = req.headers.get("authorization") || "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-api-key");
  if (!(await safeEqual(key, env.APPLE_INGEST_KEY))) return new Response("Unauthorized", { status: 401 });
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 20 * 1024 * 1024) return new Response("Too large", { status: 413 });
  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  const metrics = body?.data?.metrics || body?.metrics || [];
  const agg = new Map(); // fecha|metrica -> {fecha, metrica, unidad, suma, n}
  for (const m of metrics) {
    const name = String(m.name || "").slice(0, 80);
    if (!name) continue;
    for (const p of m.data || []) {
      const fecha = toLimaDate(p.date);
      const v = typeof p.qty === "number" ? p.qty : typeof p.Avg === "number" ? p.Avg : typeof p.avg === "number" ? p.avg : null;
      if (!fecha || v === null) continue;
      const k = fecha + "|" + name;
      const o = agg.get(k) || { fecha, metrica: name, unidad: String(m.units || ""), suma: 0, n: 0 };
      o.suma += v;
      o.n += 1;
      agg.set(k, o);
    }
  }
  const stmts = [];
  for (const o of agg.values()) {
    const valor = AVG_METRICS.test(o.metrica) ? o.suma / o.n : o.suma;
    stmts.push(
      env.HUB_DB.prepare(
        "INSERT INTO apple_diario (fecha, metrica, unidad, valor, actualizado) VALUES (?, ?, ?, ?, ?) ON CONFLICT(fecha, metrica) DO UPDATE SET unidad=excluded.unidad, valor=excluded.valor, actualizado=excluded.actualizado"
      ).bind(o.fecha, o.metrica, o.unidad, Math.round(valor * 1000) / 1000, new Date().toISOString())
    );
  }
  for (let i = 0; i < stmts.length; i += 90) await env.HUB_DB.batch(stmts.slice(i, i + 90));
  await env.HUB_KV.put("apple:last_ingest", JSON.stringify({ at: new Date().toISOString(), registros: stmts.length, metricas: [...new Set([...agg.values()].map((o) => o.metrica))] }));
  return Response.json({ ok: true, registros: stmts.length });
}

export async function appleStatus(env) {
  const raw = await env.HUB_KV.get("apple:last_ingest");
  if (!raw) return { conectado: false, nota: "Todavía no llega ningún envío de Health Auto Export." };
  return { conectado: true, ultimo_envio: JSON.parse(raw) };
}

export const appleTools = [
  {
    name: "apple_salud_diario",
    description:
      "Datos diarios de Apple Salud (fecha en hora de Lima), una fila por día y una columna por métrica: pasos, distancia caminada, energía activa, proteína/calorías/macros de MyFitnessPal, peso, etc. Las métricas usan los nombres de Health Auto Export (ej. step_count, walking_running_distance, active_energy, dietary_protein, dietary_energy).",
    inputSchema: {
      type: "object",
      properties: {
        dias: { type: "number", description: "Días hacia atrás (30 por defecto, tope 5000)" },
        metricas: { type: "array", items: { type: "string" }, description: "Filtrar a estas métricas (opcional)" },
      },
    },
    run: async (env, a) => {
      const dias = Math.min(Math.max(Number(a?.dias) || 30, 1), 5000);
      const desde = new Date(Date.now() - 5 * 3600e3 - dias * 86400000).toISOString().slice(0, 10);
      const { results } = await env.HUB_DB.prepare("SELECT fecha, metrica, unidad, valor FROM apple_diario WHERE fecha >= ? ORDER BY fecha").bind(desde).all();
      const filtro = Array.isArray(a?.metricas) && a.metricas.length ? new Set(a.metricas) : null;
      const byDate = new Map();
      const unidades = {};
      for (const r of results) {
        if (filtro && !filtro.has(r.metrica)) continue;
        const row = byDate.get(r.fecha) || { fecha: r.fecha };
        row[r.metrica] = r.valor;
        unidades[r.metrica] = r.unidad;
        byDate.set(r.fecha, row);
      }
      return { unidades, rows: [...byDate.values()] };
    },
  },
  {
    name: "apple_salud_metricas",
    description: "Lista las métricas de Apple Salud que el hub ha recibido, con su unidad, días registrados y última fecha.",
    inputSchema: { type: "object", properties: {} },
    run: async (env) => {
      const { results } = await env.HUB_DB.prepare(
        "SELECT metrica, unidad, COUNT(*) AS dias, MAX(fecha) AS ultima_fecha FROM apple_diario GROUP BY metrica, unidad ORDER BY metrica"
      ).all();
      return results;
    },
  },
];
