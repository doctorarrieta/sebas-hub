// Convierte src/equipo.html en un módulo JS (src/equipo-pagina.js) para el Worker y las pruebas.
// Uso: node scripts/pagina-equipo.mjs  (después de editar src/equipo.html)
import { readFileSync, writeFileSync } from "node:fs";
const html = readFileSync(new URL("../src/equipo.html", import.meta.url), "utf8");
writeFileSync(new URL("../src/equipo-pagina.js", import.meta.url), `// Generado por scripts/pagina-equipo.mjs desde src/equipo.html. No editar a mano.\nexport default ${JSON.stringify(html)};\n`);
console.log("src/equipo-pagina.js listo");
