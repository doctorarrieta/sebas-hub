// Convierte el prompt de sistema del auditor (Markdown) en src/auditor-sistema.js.
// Uso: node scripts/auditor-sistema.mjs ruta/al/sistema.md
import { readFileSync, writeFileSync } from "node:fs";
const md = readFileSync(process.argv[2] || new URL("../src/auditor-sistema.md", import.meta.url), "utf8").trim();
writeFileSync(new URL("../src/auditor-sistema.js", import.meta.url), `// Generado por scripts/auditor-sistema.mjs. No editar a mano.\nexport default ${JSON.stringify(md)};\n`);
console.log("src/auditor-sistema.js listo:", md.split(/\s+/).length, "palabras");
