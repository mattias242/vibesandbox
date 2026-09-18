'use strict';
// Läser results/matrix.jsonl, dedupe (senaste per browser+id vinner) och skriver
// en läsbar matris till stdout. Firefox = OMÄTT (miljöblockerad, se RESULTAT.md).
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, 'results', 'matrix.jsonl');
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byKey = new Map();
for (const r of rows) byKey.set(r.browser + '|' + r.id, r); // last-wins
const ids = [...new Set([...byKey.values()].map((r) => r.id))];
const engines = ['chromium', 'webkit', 'firefox'];
const q = {};
for (const r of byKey.values()) q[r.id] = r.fraga;
let out = '| ID | Fråga | chromium | webkit | firefox |\n|---|---|---|---|---|\n';
for (const id of ids) {
  const cells = engines.map((e) => {
    if (e === 'firefox') return 'OMÄTT';
    const r = byKey.get(e + '|' + id);
    return r ? r.utfall : '–';
  });
  out += `| ${id} | ${q[id]} | ${cells[0]} | ${cells[1]} | ${cells[2]} |\n`;
}
console.log(out);
console.log('\n--- DETALJER (chromium/webkit) ---');
for (const id of ids) {
  for (const e of ['chromium', 'webkit']) {
    const r = byKey.get(e + '|' + id);
    if (r) console.log(`[${e}] ${id}: ${r.utfall} — ${r.detalj}`);
  }
}
