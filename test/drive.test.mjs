import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
import * as P from "../src/publicar.js";
import * as D from "../src/drive.js";
import * as C from "../src/contenido.js";
const { env, dispose } = await getPlatformProxy({ environment: "contenido", persist: false });
for (const stmt of readFileSync("schema.sql", "utf8").split(";").map((s) => s.trim()).filter(Boolean)) await env.HUB_DB.prepare(stmt).run();
const ok = (c, m) => { if (!c) { console.error("FALLA:", m); process.exitCode = 1; } else console.log("ok -", m); };
env.YOUTUBE_CLIENT_ID = "ytid"; env.YOUTUBE_CLIENT_SECRET = "ytsec";
const R = (j, s = 200) => new Response(JSON.stringify(j), { status: s, headers: { "content-type": "application/json" } });
const L = [];
let n = 0;
const fake = async (url, init = {}) => {
  url = String(url); const body = init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init.body || ""); L.push({ url, body, init });
  if (url.includes("oauth2.googleapis.com/token")) return R({ access_token: "d1", refresh_token: "drt", expires_in: 3599 });
  if (url.includes("/about?")) return R({ user: { emailAddress: "seb@x.com" } });
  if (url.startsWith("https://export-download.canva.com/")) return url.includes("vencido") ? new Response("no", { status: 403 }) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
  if (url.includes("/upload/drive/v3/files")) return R({ id: "f" + ++n, webViewLink: `https://drive.google.com/file/d/f${n}/view` });
  if (url.includes("/drive/v3/files?")) return R({ id: "c" + ++n });
  if (url.includes("/drive/v3/files/")) return R({ id: "x", trashed: false });
  return R({ error: { message: "no" } }, 404);
};
const u = new URL((await P.enlaceConexion(env, { red: "drive" })).enlace);
ok(u.searchParams.get("scope") === "https://www.googleapis.com/auth/drive.file" && u.searchParams.get("redirect_uri").endsWith("/contenido/callback/youtube"), "Drive pide solo drive.file y reutiliza la dirección de regreso de Google");
const html = await (await P.callbackConexion(env, "youtube", new URL(`https://h/contenido/callback/youtube?code=c&state=${u.searchParams.get("state")}`), fake)).text();
ok(html.includes("Drive conectado") && html.includes("seb@x.com") && (await env.HUB_KV.get("drive:raiz")), "conecta Drive y crea la carpeta raíz");
ok(!(await env.HUB_KV.get("yt:canales")), "no lo confunde con un canal de YouTube");
const p = { id: 7, titulo: "Dulces y cáncer de mama", copy: "Dos postres a la semana…", referencia: "Estudio HEXA-G, 2026", referencia_url: "https://doi.org/10/x", notas: "IMAGEN https://export-download.canva.com/a/b.png?sig=1" };
ok(D.imagenDe({}, p) === "https://export-download.canva.com/a/b.png?sig=1" && D.imagenDe({ imagen_url: "https://export-download.canva.com/z.png" }, p).endsWith("z.png"), "toma la imagen de imagen_url o de las notas");
const tx = D.textoCopy(p);
ok(tx.includes("Dos postres") && tx.includes("https://doi.org/10/x") && !tx.includes("canva"), "el copy lleva texto y referencia, sin el enlace de Canva");
const b = await D.buzonLamina(env, p, D.imagenDe({}, p), fake);
const subidas = L.filter((x) => x.url.includes("/upload/"));
ok(b.enlace.startsWith("https://drive.google.com/drive/folders/") && subidas.length === 2 && subidas[0].body.includes("image/png") && subidas[1].body.includes("application/vnd.google-apps.document"), "deja imagen y copy (Google Doc) en una carpeta nueva");
let e = null; try { await D.buzonLamina(env, p, "https://evil.com/x.png", fake); } catch (x) { e = x.message; }
ok(/Canva/.test(e || ""), "solo baja imágenes de Canva");
e = null; try { await D.buzonLamina(env, p, "https://export-download.canva.com/vencido.png", fake); } catch (x) { e = x.message; }
ok(/venció/.test(e || ""), "si el enlace de Canva venció, lo dice");
// Desde el Centro: al pasar a enviada_equipo intenta el buzón (aquí sin red real: queda el error guardado, no rompe)
await env.HUB_KV.delete("drive:conexion");
const pz = await C.registrarPieza(env, { formato: "carrusel", texto: "Lámina", copy: "c", estado: "enviada_equipo", notas: "https://export-download.canva.com/a.png" });
ok(pz.buzon && pz.buzon.ok === false && /no está conectado/.test(pz.buzon.error) && pz.drive_error, "sin Drive conectado, la pieza se guarda y el error queda anotado");
await dispose();
