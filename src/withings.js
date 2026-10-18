// Módulo Withings: OAuth, renovación automática y herramientas de composición corporal.
const API = "https://wbsapi.withings.net";
const SCOPES = "user.info,user.metrics,user.activity";

const TYPES = {
  1: "peso_kg",
  5: "masa_libre_grasa_kg",
  6: "grasa_pct",
  8: "masa_grasa_kg",
  76: "masa_muscular_kg",
  77: "agua_kg",
  88: "masa_osea_kg",
  170: "grasa_visceral",
  91: "vop_ms",
  155: "edad_vascular",
  123: "vo2max",
  9: "presion_diastolica",
  10: "presion_sistolica",
  11: "pulso",
  54: "spo2_pct",
};

export function withingsAuthUrl(env, state) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: env.WITHINGS_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: `${env.BASE_URL}/withings/callback`,
    state,
  });
  return `https://account.withings.com/oauth2_user/authorize2?${q}`;
}

async function tokenRequest(env, params) {
  const r = await fetch(`${API}/v2/oauth2`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "requesttoken",
      client_id: env.WITHINGS_CLIENT_ID,
      client_secret: env.WITHINGS_CLIENT_SECRET,
      ...params,
    }),
  });
  const j = await r.json();
  if (j.status !== 0) throw new Error(`Withings token status ${j.status}: ${j.error || ""}`);
  return j.body;
}

async function saveTokens(env, b) {
  const data = { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: Date.now() + (b.expires_in || 10800) * 1000 };
  await env.HUB_KV.put("withings:tokens", JSON.stringify(data));
  return data;
}

export async function withingsExchangeCode(env, code) {
  const b = await tokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: `${env.BASE_URL}/withings/callback` });
  await saveTokens(env, b);
}

let refreshing = null;
async function accessToken(env, force = false) {
  const raw = await env.HUB_KV.get("withings:tokens");
  if (!raw) throw new Error("Withings no está conectado. Abre /withings/connect en el hub.");
  const t = JSON.parse(raw);
  if (!force && t.expires_at - 120000 > Date.now()) return t.access_token;
  if (!refreshing) {
    refreshing = tokenRequest(env, { grant_type: "refresh_token", refresh_token: t.refresh_token })
      .then((b) => saveTokens(env, b))
      .finally(() => (refreshing = null));
  }
  return (await refreshing).access_token;
}

async function call(env, path, params) {
  const go = async (force) => {
    const r = await fetch(`${API}${path}`, {
      method: "POST",
      headers: { Authorization: "Bearer " + (await accessToken(env, force)), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    return r.json();
  };
  let j = await go(false);
  if (j.status === 401) j = await go(true);
  if (j.status !== 0) throw new Error(`Withings ${params.action} status ${j.status}: ${j.error || ""}`);
  return j.body;
}

const limaDate = (sec) => new Date(sec * 1000 - 5 * 3600e3).toISOString().slice(0, 10);
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

export async function withingsStatus(env) {
  if (!(await env.HUB_KV.get("withings:tokens"))) return { conectado: false };
  await call(env, "/measure", { action: "getmeas", meastypes: "1", lastupdate: String(Math.floor(Date.now() / 1000) - 86400) });
  return { conectado: true };
}

// Una fila por día (hora de Lima) con la última medición de cada tipo ese día.
export async function withingsDaily(env, { dias = 90 } = {}) {
  dias = Math.min(Math.max(Number(dias) || 90, 1), 730);
  const now = Math.floor(Date.now() / 1000);
  const body = await call(env, "/measure", {
    action: "getmeas",
    meastypes: Object.keys(TYPES).join(","),
    category: "1",
    startdate: String(now - (dias + 1) * 86400),
    enddate: String(now),
  });
  const byDate = new Map();
  const grps = (body.measuregrps || []).slice().sort((a, b) => a.date - b.date);
  for (const g of grps) {
    const fecha = limaDate(g.date);
    const row = byDate.get(fecha) || { fecha };
    for (const m of g.measures || []) {
      const k = TYPES[m.type];
      if (!k) continue;
      row[k] = round(m.value * 10 ** m.unit, k === "peso_kg" || k.endsWith("_kg") || k === "grasa_pct" ? 2 : 1);
    }
    byDate.set(fecha, row);
  }
  return { rows: [...byDate.values()].sort((a, b) => a.fecha.localeCompare(b.fecha)) };
}

export async function withingsActivity(env, { dias = 30 } = {}) {
  dias = Math.min(Math.max(Number(dias) || 30, 1), 365);
  const end = new Date(Date.now() - 5 * 3600e3);
  const start = new Date(end.getTime() - dias * 86400000);
  const body = await call(env, "/v2/measure", {
    action: "getactivity",
    startdateymd: start.toISOString().slice(0, 10),
    enddateymd: end.toISOString().slice(0, 10),
    data_fields: "steps,distance,calories,totalcalories,soft,moderate,intense,hr_average",
  });
  return {
    rows: (body.activities || []).map((a) => ({
      fecha: a.date,
      pasos: a.steps,
      distancia_km: a.distance != null ? round(a.distance / 1000, 2) : null,
      calorias_activas: a.calories != null ? Math.round(a.calories) : null,
      minutos_moderados: a.moderate != null ? Math.round(a.moderate / 60) : null,
      minutos_intensos: a.intense != null ? Math.round(a.intense / 60) : null,
      fc_promedio: a.hr_average ?? null,
    })),
  };
}

export const withingsTools = [
  {
    name: "withings_composicion",
    description: "Mediciones diarias de Withings (fecha en hora de Lima): peso, % grasa, masa grasa, masa libre de grasa, masa muscular, agua, masa ósea, grasa visceral, velocidad de onda de pulso, edad vascular, VO2max, presión y SpO2 cuando existan.",
    inputSchema: { type: "object", properties: { dias: { type: "number", description: "Días hacia atrás (90 por defecto, tope 730)" } } },
    run: (env, a) => withingsDaily(env, a),
  },
  {
    name: "withings_actividad",
    description: "Actividad diaria registrada por Withings: pasos, distancia, calorías activas, minutos moderados e intensos y FC promedio.",
    inputSchema: { type: "object", properties: { dias: { type: "number", description: "Días hacia atrás (30 por defecto)" } } },
    run: (env, a) => withingsActivity(env, a),
  },
];
