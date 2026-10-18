// Hub de conectores de Sebastián para Claude.
// Un mismo código, desplegado por espacios: SPACE="salud", "contenido" (y "ceo" a futuro).
// Cada espacio es un Worker aparte con su propia base de datos: la salud nunca se mezcla con el contenido.
import { OAuthProvider, AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { whoopTools, whoopAuthUrl, whoopExchangeCode, whoopStatus, whoopDeviation } from "./whoop.js";
import { withingsTools, withingsAuthUrl, withingsExchangeCode, withingsStatus, withingsDaily, withingsActivity } from "./withings.js";
import { appleTools, appleIngest, appleStatus } from "./apple.js";
import { contenidoTools, contenidoHttp, contenidoResumen } from "./contenido.js";

const MODULES = {
  salud: { title: "Salud Sebastián", tools: [...whoopTools, ...withingsTools, ...appleTools] },
  contenido: { title: "Contenido Dr. Arrieta", tools: contenidoTools },
  ceo: { title: "CEO DOCTORARRIETA", tools: [] }, // módulos de empresa: siguiente fase
};

const PROTOCOL = "2025-06-18";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// ---------- Página base ----------
function page(title, body, headers = {}) {
  return new Response(
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1b;--mut:#6b6a66;--card:#fff;--acc:#1f5c4a;--bd:#e3e1dc;--warn:#9a3b12}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#efede8;--mut:#a3a19b;--card:#1e1e1c;--acc:#6fbf9f;--bd:#33322f;--warn:#f09a6a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:440px;margin:10vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:24px}
h1{font-size:1.3rem;margin:0 0 8px}p{color:var(--mut);margin:8px 0}input{width:100%;padding:12px;border:1px solid var(--bd);border-radius:10px;background:var(--bg);color:var(--fg);font-size:16px;margin:12px 0}
button{padding:12px 18px;border-radius:10px;border:0;font-size:15px;cursor:pointer}.pri{background:var(--acc);color:#fff}.sec{background:transparent;color:var(--mut);border:1px solid var(--bd)}
.warn{color:var(--warn)}.row{display:flex;gap:8px;flex-wrap:wrap}code{font-size:.9em}
</style><main><div class="card">${body}</div></main></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", ...headers } }
  );
}

// ---------- Contraseña del hub (secreto HUB_PASSPHRASE), con bloqueo por intentos ----------
async function checkPassphrase(env, given) {
  const key = "lock:" + new Date().toISOString().slice(0, 13); // ventana de 1 hora
  const fails = Number((await env.HUB_KV.get(key)) || 0);
  if (fails >= 8) return { ok: false, locked: true };
  const a = new TextEncoder().encode(String(given || ""));
  const b = new TextEncoder().encode(String(env.HUB_PASSPHRASE || ""));
  let ok = !!env.HUB_PASSPHRASE && a.length === b.length;
  if (ok) {
    const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", a), crypto.subtle.digest("SHA-256", b)]);
    const x = new Uint8Array(ha), y = new Uint8Array(hb);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    ok = diff === 0;
  }
  if (!ok) await env.HUB_KV.put(key, String(fails + 1), { expirationTtl: 3700 });
  return { ok, locked: false };
}

// ---------- Página de autorización (Claude -> hub) ----------
async function authorize(req, env) {
  const oauth = env.OAUTH_PROVIDER;
  const space = MODULES[env.SPACE];
  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      return page(
        `Autorizar ${space.title}`,
        `<h1>Conectar ${esc(details.clientName)} a ${esc(space.title)}</h1>
<p>El acceso se enviará a <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>Esto envía acceso a una app en tu computadora.</strong> Sigue solo si acabas de iniciarlo tú.</p>' : ""}
${details.clientDomain ? "" : '<p class="warn">Esta app se registró sola; su nombre no está verificado.</p>'}
<form method="post">
<input type="hidden" name="handle" value="${esc(consent.handle)}">
<input type="password" name="passphrase" placeholder="Contraseña del hub" autocomplete="current-password" required autofocus>
<div class="row"><button class="pri" name="decision" value="approve">Permitir</button><button class="sec" name="decision" value="deny" formnovalidate>Rechazar</button></div>
</form>`,
        Object.fromEntries(consent.headers)
      );
    }
    if (req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const pass = await checkPassphrase(env, form.get("passphrase"));
      if (!pass.ok) {
        return page("No autorizado", `<h1>No autorizado</h1><p>${pass.locked ? "Demasiados intentos. Espera una hora." : "Contraseña incorrecta."} Vuelve a Claude e inténtalo de nuevo.</p>`);
      }
      const approved = await oauth.approveConsent(req, handle, {});
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: "sebastian",
        metadata: { space: env.SPACE },
        scope: approved.request.scope,
        props: { userId: "sebastian", space: env.SPACE },
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    if (e instanceof AuthorizationError && e.redirectTo) return Response.redirect(e.redirectTo, 302);
    if (e instanceof AuthorizationError || e instanceof CimdFetchError) {
      const msg = e instanceof AuthorizationError ? e.description : "No se pudo verificar la app.";
      return page("Error", `<h1>No se pudo continuar</h1><p>${esc(msg)}</p><p>Vuelve a Claude e inténtalo otra vez.</p>`);
    }
    throw e;
  }
}

// ---------- Conexión de servicios (hub -> WHOOP / Withings), protegida con la contraseña ----------
const SERVICES = {
  whoop: { nombre: "WHOOP", authUrl: whoopAuthUrl, exchange: whoopExchangeCode, status: whoopStatus },
  withings: { nombre: "Withings", authUrl: withingsAuthUrl, exchange: withingsExchangeCode, status: withingsStatus },
};

async function serviceConnect(req, env, key) {
  const s = SERVICES[key];
  if (req.method === "GET") {
    return page(
      `Conectar ${s.nombre}`,
      `<h1>Conectar ${s.nombre}</h1><p>Confirma con la contraseña del hub. Luego ${s.nombre} te pedirá autorizar.</p>
<form method="post"><input type="password" name="passphrase" placeholder="Contraseña del hub" required autofocus>
<button class="pri">Continuar a ${s.nombre}</button></form>`
    );
  }
  const form = await req.formData();
  const pass = await checkPassphrase(env, form.get("passphrase"));
  if (!pass.ok) return page("No autorizado", `<h1>No autorizado</h1><p>${pass.locked ? "Demasiados intentos. Espera una hora." : "Contraseña incorrecta."}</p>`);
  const state = crypto.randomUUID().replace(/-/g, "");
  await env.HUB_KV.put(`${key}:state:` + state, "1", { expirationTtl: 900 });
  return Response.redirect(s.authUrl(env, state), 302);
}

async function serviceCallback(url, env, key) {
  const s = SERVICES[key];
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code && !state) return page(s.nombre, `<h1>${s.nombre}</h1><p>Ruta de retorno del hub.</p>`);
  if (!code || !state || !(await env.HUB_KV.get(`${key}:state:` + state)))
    return page(s.nombre, `<h1>No se pudo conectar</h1><p>La autorización expiró o no es válida. Abre <code>/${key}/connect</code> otra vez.</p>`);
  await env.HUB_KV.delete(`${key}:state:` + state);
  await s.exchange(env, code);
  await s.status(env);
  return page(`${s.nombre} conectado`, `<h1>${s.nombre} conectado</h1><p>Ya puedes cerrar esta pestaña y volver a Claude.</p>`);
}

// ---------- Rutas públicas que no son MCP ----------
const defaultHandler = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/authorize") return authorize(req, env);
    if (env.SPACE === "salud" && url.pathname === "/apple/ingest") return appleIngest(req, env);
    if (env.SPACE === "contenido" && url.pathname.startsWith("/contenido/")) return contenidoHttp(req, env, url);
    const m = url.pathname.match(/^\/(whoop|withings)\/(connect|callback)$/);
    if (env.SPACE === "salud" && m) return m[2] === "connect" ? serviceConnect(req, env, m[1]) : serviceCallback(url, env, m[1]);
    if (url.pathname === "/") return page(MODULES[env.SPACE].title, `<h1>${esc(MODULES[env.SPACE].title)}</h1><p>Hub privado de conectores para Claude.</p>`);
    return new Response("Not found", { status: 404 });
  },
};

// ---------- Servidor MCP (solo con token válido) ----------
const apiHandler = {
  async fetch(req, env, ctx) {
    if (ctx.props?.space !== env.SPACE) return new Response("Forbidden", { status: 403 });
    if (req.method === "GET") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let msg;
    try {
      msg = await req.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }
    // El historial de alertas es solo del espacio salud.
    const tools = MODULES[env.SPACE].tools.concat(hubTools.filter((t) => env.SPACE === "salud" || t.name !== "hub_historial_alertas"));
    const handleOne = (m) => rpc(m, env, tools);
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map(handleOne))).filter(Boolean);
      return out.length ? Response.json(out) : new Response(null, { status: 202 });
    }
    const res = await handleOne(msg);
    return res ? Response.json(res) : new Response(null, { status: 202 });
  },
};

const hubTools = [
  {
    name: "hub_estado",
    description: "Estado del hub: qué módulos están conectados y la última alerta guardada.",
    inputSchema: { type: "object", properties: {} },
    run: async (env) => {
      const out = { espacio: env.SPACE, modulos: {} };
      if (env.SPACE === "salud") {
        out.modulos.whoop = await whoopStatus(env).catch((e) => ({ error: e.message }));
        out.modulos.withings = await withingsStatus(env).catch((e) => ({ error: e.message }));
        out.modulos.apple_salud = await appleStatus(env).catch((e) => ({ error: e.message }));
        if (out.modulos.withings.conectado) {
          const c = await withingsDaily(env, { dias: 30 }).catch((e) => ({ error: e.message }));
          const a = await withingsActivity(env, { dias: 7 }).catch((e) => ({ error: e.message }));
          out.modulos.withings.ultima_medicion = c.rows ? c.rows[c.rows.length - 1] || null : c;
          out.modulos.withings.dias_con_medicion_30d = c.rows ? c.rows.length : null;
          out.modulos.withings.ultimo_dia_actividad = a.rows ? a.rows[a.rows.length - 1] || null : a;
        }
      }
      if (env.SPACE === "contenido") {
        out.modulos.contenido = await contenidoResumen(env).catch((e) => ({ error: e.message }));
        return out;
      }
      const last = await env.HUB_DB.prepare("SELECT fecha, nivel, json FROM alertas ORDER BY fecha DESC LIMIT 1").first().catch(() => null);
      out.ultima_alerta = last ? { fecha: last.fecha, nivel: last.nivel } : null;
      return out;
    },
  },
  {
    name: "hub_historial_alertas",
    description: "Historial de las revisiones diarias automáticas de desvío (NORMAL / VIGILAR / ALERTA) guardadas por el hub.",
    inputSchema: { type: "object", properties: { dias: { type: "number", description: "Cuántos días hacia atrás (30 por defecto)" } } },
    run: async (env, a) => {
      const dias = Math.min(Number(a?.dias) || 30, 365);
      const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
      const { results } = await env.HUB_DB.prepare("SELECT fecha, nivel, json FROM alertas WHERE fecha >= ? ORDER BY fecha DESC").bind(desde).all();
      return results.map((r) => ({ fecha: r.fecha, nivel: r.nivel, ...JSON.parse(r.json) }));
    },
  },
];

async function rpc(m, env, tools) {
  const { id, method, params } = m || {};
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: `sebas-hub-${env.SPACE}`, version: "1.0.0" },
        instructions: `${MODULES[env.SPACE].title}. Fechas en ISO 8601 (UTC). Zona horaria del usuario: America/Lima.`,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: "Herramienta desconocida" } };
      try {
        const data = await tool.run(env, params?.arguments || {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: "Error: " + e.message }], isError: true });
      }
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Método no soportado" } };
  }
}

// ---------- Ensamblado ----------
let provider;
function getProvider(env) {
  if (!provider) {
    provider = new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [env.SPACE],
      refreshTokenIdleTTL: 60 * 60 * 24 * 60, // la sesión de Claude dura mientras se use (60 días de inactividad)
      resourceMetadata: {
        resource: `${env.BASE_URL}/mcp`,
        authorization_servers: [env.BASE_URL],
        resource_name: MODULES[env.SPACE].title,
      },
    });
  }
  return provider;
}

export default {
  fetch(req, env, ctx) {
    return getProvider(env).fetch(req, env, ctx);
  },
  // Revisión diaria automática (cron): guarda el estado de desvío del día.
  async scheduled(event, env, ctx) {
    if (env.SPACE !== "salud") return;
    try {
      const r = await whoopDeviation(env, {});
      if (r.error) return;
      const fecha = String(r.fecha).slice(0, 10);
      await env.HUB_DB.prepare("INSERT OR REPLACE INTO alertas (fecha, nivel, json) VALUES (?, ?, ?)")
        .bind(fecha, r.nivel, JSON.stringify(r)).run();
    } catch (e) {
      console.error("cron", e.message);
    }
  },
};
