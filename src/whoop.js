// Módulo WHOOP: acceso OAuth a WHOOP, renovación automática y herramientas.
const WHOOP = "https://api.prod.whoop.com";
export const WHOOP_SCOPES =
  "offline read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement";
const UA = { "User-Agent": "SebasHub/1.0" };

export function whoopAuthUrl(env, state) {
  const q = new URLSearchParams({
    client_id: env.WHOOP_CLIENT_ID,
    redirect_uri: `${env.BASE_URL}/whoop/callback`,
    response_type: "code",
    scope: WHOOP_SCOPES,
    state,
  });
  return `${WHOOP}/oauth/oauth2/auth?${q}`;
}

async function tokenRequest(env, params) {
  const r = await fetch(`${WHOOP}/oauth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...UA },
    body: new URLSearchParams({ ...params, client_id: env.WHOOP_CLIENT_ID, client_secret: env.WHOOP_CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`WHOOP token ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function saveTokens(env, tok) {
  const data = {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: Date.now() + (tok.expires_in || 3600) * 1000,
  };
  await env.HUB_KV.put("whoop:tokens", JSON.stringify(data));
  return data;
}

export async function whoopExchangeCode(env, code) {
  const tok = await tokenRequest(env, {
    grant_type: "authorization_code",
    code,
    redirect_uri: `${env.BASE_URL}/whoop/callback`,
  });
  await saveTokens(env, tok);
}

let refreshing = null;
async function accessToken(env, force = false) {
  const raw = await env.HUB_KV.get("whoop:tokens");
  if (!raw) throw new Error("WHOOP no está conectado. Abre /whoop/connect en el hub para autorizar.");
  const t = JSON.parse(raw);
  if (!force && t.expires_at - 120000 > Date.now()) return t.access_token;
  if (!refreshing) {
    refreshing = tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh_token, scope: "offline" })
      .then((tok) => saveTokens(env, tok))
      .finally(() => (refreshing = null));
  }
  return (await refreshing).access_token;
}

async function whoopGet(env, path, params = {}) {
  const q = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")
  );
  const go = async (force) =>
    fetch(`${WHOOP}${path}${q.toString() ? "?" + q : ""}`, {
      headers: { Authorization: "Bearer " + (await accessToken(env, force)), ...UA },
    });
  let r = await go(false);
  if (r.status === 401) r = await go(true);
  if (!r.ok) throw new Error(`WHOOP ${path} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function collect(env, path, { start, end, max = 30 } = {}) {
  const out = [];
  let nextToken;
  max = Math.min(Math.max(1, Number(max) || 30), 400);
  do {
    const page = await whoopGet(env, path, { start, end, limit: Math.min(25, max - out.length), nextToken });
    out.push(...(page.records || []));
    nextToken = page.next_token;
  } while (nextToken && out.length < max);
  return out;
}

export async function whoopStatus(env) {
  if (!(await env.HUB_KV.get("whoop:tokens"))) return { conectado: false };
  const p = await whoopGet(env, "/developer/v2/user/profile/basic");
  return { conectado: true, usuario: p.first_name };
}

// ---- Alerta de desvío: compara el último día con tu propia línea base de 30 días ----
function stats(arr) {
  const v = arr.filter((x) => typeof x === "number");
  if (v.length < 7) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) || 1e-9;
  return { mean, sd, n: v.length };
}

export async function whoopDeviation(env, { days = 30 } = {}) {
  const start = new Date(Date.now() - (Number(days) + 2) * 86400000).toISOString();
  const [rec, sleep] = await Promise.all([
    collect(env, "/developer/v2/recovery", { start, max: 60 }),
    collect(env, "/developer/v2/activity/sleep", { start, max: 80 }),
  ]);
  const recs = rec.filter((r) => r.score_state === "SCORED" && r.score).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  const sleeps = sleep.filter((s) => !s.nap && s.score_state === "SCORED" && s.score).sort((a, b) => a.start < b.start ? 1 : -1);
  if (recs.length < 8) return { error: "No hay suficientes días registrados para una línea base." };
  const [today, ...base] = recs;
  const [lastSleep, ...baseSleep] = sleeps;
  const metrics = [
    { key: "fc_reposo", label: "FC en reposo", val: today.score.resting_heart_rate, b: stats(base.map((r) => r.score.resting_heart_rate)), bad: +1 },
    { key: "vfc", label: "VFC (ms)", val: today.score.hrv_rmssd_milli, b: stats(base.map((r) => r.score.hrv_rmssd_milli)), bad: -1 },
    { key: "temp_piel", label: "Temperatura de piel (°C)", val: today.score.skin_temp_celsius, b: stats(base.map((r) => r.score.skin_temp_celsius)), bad: +1 },
    { key: "spo2", label: "SpO2 (%)", val: today.score.spo2_percentage, b: stats(base.map((r) => r.score.spo2_percentage)), bad: -1 },
    { key: "frec_resp", label: "Frecuencia respiratoria", val: lastSleep?.score?.respiratory_rate, b: stats(baseSleep.map((s) => s.score.respiratory_rate)), bad: +1 },
  ];
  const detalle = metrics
    .filter((m) => typeof m.val === "number" && m.b)
    .map((m) => {
      const z = (m.val - m.b.mean) / m.b.sd;
      const malo = z * m.bad;
      return {
        metrica: m.label,
        hoy: Math.round(m.val * 10) / 10,
        tu_promedio: Math.round(m.b.mean * 10) / 10,
        desvios: Math.round(z * 10) / 10,
        estado: malo >= 2 ? "fuera de tu rango" : malo >= 1 ? "vigilar" : "normal para ti",
      };
    });
  const fuera = detalle.filter((d) => d.estado === "fuera de tu rango").length;
  const vigilar = detalle.filter((d) => d.estado === "vigilar").length;
  const nivel = fuera >= 2 || (fuera >= 1 && vigilar >= 2) ? "ALERTA" : fuera + vigilar >= 2 ? "VIGILAR" : "NORMAL";
  return {
    fecha: today.created_at,
    recuperacion: today.score.recovery_score,
    nivel,
    linea_base: `${base.length} días previos`,
    detalle,
    nota: "Alcohol, cena tardía, viaje, calor o un salto de carga mueven estas mismas señales. Revisar contexto antes de interpretar como enfermedad.",
  };
}

// ---- Serie diaria (mismo formato que el export de WHOOP usado en el tablero) ----
const limaDate = (iso) => new Date(new Date(iso).getTime() - 5 * 3600e3).toISOString().slice(0, 10);
const r1 = (x, d = 0) => (typeof x === "number" ? Math.round(x * 10 ** d) / 10 ** d : null);

export async function whoopDaily(env, { dias = 60 } = {}) {
  dias = Math.min(Math.max(Number(dias) || 60, 1), 365);
  const start = new Date(Date.now() - (dias + 1) * 86400000).toISOString();
  const max = dias + 10;
  const [recs, sleeps, cycles] = await Promise.all([
    collect(env, "/developer/v2/recovery", { start, max }),
    collect(env, "/developer/v2/activity/sleep", { start, max: max * 2 }),
    collect(env, "/developer/v2/cycle", { start, max }),
  ]);
  const sleepById = new Map(sleeps.map((s) => [s.id, s]));
  const cycleById = new Map(cycles.map((c) => [c.id, c]));
  const byDate = new Map();
  for (const r of recs) {
    if (r.score_state !== "SCORED" || !r.score) continue;
    const s = sleepById.get(r.sleep_id);
    const c = cycleById.get(r.cycle_id);
    const fecha = limaDate(s?.end || r.created_at);
    const st = s?.score?.stage_summary || {};
    const asleep = (st.total_light_sleep_time_milli || 0) + (st.total_slow_wave_sleep_time_milli || 0) + (st.total_rem_sleep_time_milli || 0);
    byDate.set(fecha, {
      fecha,
      recuperacion: r1(r.score.recovery_score),
      fc_reposo: r1(r.score.resting_heart_rate),
      vfc: r1(r.score.hrv_rmssd_milli),
      esfuerzo: c?.end && c?.score ? r1(c.score.strain, 1) : null,
      sueno_h: s ? r1(asleep / 3600000, 2) : null,
      calidad_sueno: r1(s?.score?.sleep_performance_percentage),
      profundo_min: s ? r1((st.total_slow_wave_sleep_time_milli || 0) / 60000) : null,
      rem_min: s ? r1((st.total_rem_sleep_time_milli || 0) / 60000) : null,
      deuda_min: s?.score?.sleep_needed ? r1((s.score.sleep_needed.need_from_sleep_debt_milli || 0) / 60000) : null,
    });
  }
  return { rows: [...byDate.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)) };
}

const rangeSchema = {
  type: "object",
  properties: {
    start: { type: "string", description: "Inicio ISO 8601 (UTC), ej. 2026-09-01T00:00:00Z" },
    end: { type: "string", description: "Fin ISO 8601 (opcional)" },
    max: { type: "number", description: "Máximo de registros (30 por defecto, tope 400)" },
  },
};

export const whoopTools = [
  {
    name: "whoop_diario",
    description: "Serie diaria (fecha en hora de Lima): recuperación, FC en reposo, VFC, esfuerzo, horas de sueño, calidad de sueño, sueño profundo, REM y deuda de sueño. Mismo formato que el export de WHOOP; ideal para tableros.",
    inputSchema: { type: "object", properties: { dias: { type: "number", description: "Días hacia atrás (60 por defecto, tope 365)" } } },
    run: (env, a) => whoopDaily(env, a),
  },
  {
    name: "whoop_resumen_hoy",
    description: "Lo más reciente de WHOOP: última recuperación (score, VFC, FC en reposo, SpO2, temperatura de piel), último sueño y ciclo del día con su esfuerzo.",
    inputSchema: { type: "object", properties: {} },
    run: async (env) => {
      const [rec, sleep, cycle] = await Promise.all([
        whoopGet(env, "/developer/v2/recovery", { limit: 1 }),
        whoopGet(env, "/developer/v2/activity/sleep", { limit: 1 }),
        whoopGet(env, "/developer/v2/cycle", { limit: 1 }),
      ]);
      return { recuperacion: rec.records?.[0], sueno: sleep.records?.[0], ciclo: cycle.records?.[0] };
    },
  },
  {
    name: "whoop_alerta_desvio",
    description: "Compara el último día con la línea base personal de los 30 días previos (FC en reposo, VFC, temperatura de piel, SpO2, frecuencia respiratoria) y marca NORMAL / VIGILAR / ALERTA. Útil para detectar enfermedad o sobrecarga temprano.",
    inputSchema: { type: "object", properties: { days: { type: "number", description: "Días de línea base (30 por defecto)" } } },
    run: (env, a) => whoopDeviation(env, a),
  },
  {
    name: "whoop_recuperacion",
    description: "Registros de recuperación (score %, VFC rmssd ms, FC en reposo, SpO2, temperatura de piel) en un rango de fechas.",
    inputSchema: rangeSchema,
    run: (env, a) => collect(env, "/developer/v2/recovery", a),
  },
  {
    name: "whoop_sueno",
    description: "Registros de sueño (inicio/fin, etapas, necesidad, eficiencia, consistencia, frecuencia respiratoria) en un rango de fechas.",
    inputSchema: rangeSchema,
    run: (env, a) => collect(env, "/developer/v2/activity/sleep", a),
  },
  {
    name: "whoop_ciclos",
    description: "Ciclos fisiológicos diarios (esfuerzo del día, FC promedio y máxima, kilojoules) en un rango de fechas.",
    inputSchema: rangeSchema,
    run: (env, a) => collect(env, "/developer/v2/cycle", a),
  },
  {
    name: "whoop_entrenamientos",
    description: "Entrenamientos (deporte, esfuerzo, FC, tiempo en zonas, kilojoules) en un rango de fechas.",
    inputSchema: rangeSchema,
    run: (env, a) => collect(env, "/developer/v2/activity/workout", a),
  },
  {
    name: "whoop_perfil",
    description: "Perfil básico y medidas corporales registradas en WHOOP (altura, peso, FC máxima).",
    inputSchema: { type: "object", properties: {} },
    run: async (env) => ({
      perfil: await whoopGet(env, "/developer/v2/user/profile/basic"),
      medidas: await whoopGet(env, "/developer/v2/user/measurement/body"),
    }),
  },
];
