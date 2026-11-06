import { getPlatformProxy } from "wrangler";
import { readFileSync } from "node:fs";
import * as E from "../src/equipo.js";
import * as C from "../src/contenido.js";
const { env, dispose } = await getPlatformProxy({ environment: "contenido", persist: false });
for (const stmt of readFileSync("schema.sql", "utf8").split(";").map((s) => s.trim()).filter(Boolean)) await env.HUB_DB.prepare(stmt).run();
const ok = (c, m) => { if (!c) { console.error("FALLA:", m); process.exitCode = 1; } else console.log("ok -", m); };
const get = (path) => E.equipoHttp(new Request("https://h" + path), env, new URL("https://h" + path));

ok((await get("/equipo/" + "a".repeat(32))).status === 404, "sin código creado, nada abre");
const { enlace } = await E.enlaceEquipo(env, {});
const cod = enlace.split("/equipo/")[1];
ok(/^[a-f0-9]{32}$/.test(cod), "enlace con código largo");
const r = await get("/equipo/" + cod);
ok(r.status === 200 && (await r.text()).includes("Tablero del equipo") && r.headers.get("x-robots-tag").includes("noindex"), "la página abre con el código y no se indexa");
ok((await get("/equipo/" + "b".repeat(32))).status === 404, "código equivocado: no abre");
await C.contenidoTools.find((t) => t.name === "contenido_guardar_rendimiento").run(env, { items: [
  { coleccion: "videos", id: "ig-dr-2026-11-01-cintura", datos: { fecha: "2026-11-01", cuenta: "Dr. Arrieta", red: "Instagram", retencion_inicial: 0.63, curva: [[0, 1], [3, 0.63]] } },
  { coleccion: "dias", id: "2026-11-02", datos: { fecha: "2026-11-02", recomendaciones: ["a"] } },
] });
const d = await (await get("/equipo/" + cod + "/datos")).json();
ok(d.videos.length === 1 && d.videos[0].retencion_inicial === 0.63 && d.dias.length === 1, "datos guardados y leídos");
await E.guardarRendimiento(env, { items: [{ coleccion: "videos", id: "ig-dr-2026-11-01-cintura", datos: { fecha: "2026-11-01", retencion_inicial: 0.7 } }] });
ok((await (await get("/equipo/" + cod + "/datos")).json()).videos[0].retencion_inicial === 0.7, "reemplaza si el id ya existe");
let err; try { await E.guardarRendimiento(env, { items: [{ coleccion: "otra", id: "x", datos: {} }] }); } catch (e) { err = e.message; }
ok(/coleccion inválida/.test(err), "rechaza colecciones que no existen");
const nuevo = (await E.enlaceEquipo(env, { renovar: true })).enlace.split("/equipo/")[1];
ok(nuevo !== cod && (await get("/equipo/" + cod)).status === 404 && (await get("/equipo/" + nuevo)).status === 200, "renovar anula el enlace anterior");
ok((await E.equipoHttp(new Request("https://h/equipo/" + nuevo, { method: "POST" }), env, new URL("https://h/equipo/" + nuevo))).status === 404, "solo lectura (no acepta POST)");

{
  const { registrarPieza } = await import("../src/contenido.js");
  await registrarPieza(env, { formato: "reel", titulo: "Reel aprobado", texto: "Guion", estado: "aprobada" });
  await registrarPieza(env, { formato: "reel", titulo: "Reel sin aprobar", texto: "Guion", estado: "por_aprobar" });
  await registrarPieza(env, { formato: "x", titulo: "Post X", texto: "x", estado: "aprobada", referencia: "r", referencia_url: "https://a" });
  const d = await E.leerRendimiento(env);
  const t = d.guiones.map((g) => g.titulo);
  ok(t.includes("Reel aprobado") && !t.includes("Reel sin aprobar") && !t.includes("Post X"), "el tablero muestra solo guiones aprobados para el equipo (sin X ni pendientes)");
}

{
  const p = await C.registrarPieza(env, { formato: "reel", titulo: "Con edición", texto: "G", estado: "aprobada", edicion: { gancho_pantalla: "TEXTO", re_gancho: "s 5", basura: "x" } });
  ok(p.edicion && p.edicion.gancho_pantalla === "TEXTO" && !p.edicion.basura, "guarda notas de edición (solo campos conocidos)");
  const g = (await E.leerRendimiento(env)).guiones.find((x) => x.titulo === "Con edición");
  ok(g && g.edicion.re_gancho === "s 5", "el tablero recibe las notas de edición");
}
await dispose();
