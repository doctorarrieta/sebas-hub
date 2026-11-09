// Convierte los prompts del auditor (Markdown) en módulos JS.
// src/auditor-sistema.md -> src/auditor-sistema.js · src/auditor-antifragil.md -> src/auditor-antifragil.js
import { readFileSync, writeFileSync } from "node:fs";
for (const n of ["auditor-sistema", "auditor-antifragil"]) {
  const md = readFileSync(new URL(`../src/${n}.md`, import.meta.url), "utf8").trim();
  writeFileSync(new URL(`../src/${n}.js`, import.meta.url), `// Generado por scripts/auditor-sistema.mjs. No editar a mano.\nexport default ${JSON.stringify(md)};\n`);
  console.log(`src/${n}.js listo:`, md.split(/\s+/).length, "palabras");
}
