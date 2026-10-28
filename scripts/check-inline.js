// Verificador de sintaxis de los scripts inline de las páginas HTML
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const dir = new URL('../public/', import.meta.url).pathname.replace(/^\//, '');
let bad = 0;

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(dir, file), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  scripts.forEach((m, i) => {
    try {
      new vm.Script(m[1], { filename: `${file}#script-${i}` });
    } catch (e) {
      bad++;
      console.log(`ERROR en ${file} (script #${i}): ${e.message}`);
    }
  });
  console.log(`${file}: ${scripts.length} scripts OK`);
}

process.exit(bad ? 1 : 0);
