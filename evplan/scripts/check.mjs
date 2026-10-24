// Komut satırından kontrol: node scripts/check.mjs [yerleşim.json ...]
// Argüman verilmezse layouts/index.json'daki tüm yerleşimler kontrol edilir.
import fs from 'node:fs';
import path from 'node:path';
import { buildPlanModel } from '../src/core/plan.js';
import { resolveItem } from '../src/core/items.js';
import { runChecks } from '../src/core/checks.js';
import { validateCatalog, validateLayout, validatePlan } from '../src/core/validate.js';

const dir = path.resolve(import.meta.dirname, '../public/data');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const plan = read(path.join(dir, 'plan.json'));
const cat = read(path.join(dir, 'furniture.json'));
const v = [validatePlan(plan), validateCatalog(cat)];
for (const r of v) for (const e of r.errors) console.log('HATA  ', e);
for (const w of v[0].warnings) console.log('UYARI ', w);
if (v.some((r) => r.errors.length)) process.exit(1);

const model = buildPlanModel(plan);
const byId = new Map(cat.items.map((i) => [i.id, i]));
let files = process.argv.slice(2);
if (!files.length) files = read(path.join(dir, 'layouts/index.json')).layouts.map((f) => path.join(dir, 'layouts', f));
let failed = false;
for (const f of files) {
  const lay = read(f);
  const errs = validateLayout(lay, cat).errors;
  if (errs.length) {
    errs.forEach((e) => console.log('HATA  ', e));
    failed = true;
    continue;
  }
  const t = performance.now();
  const r = runChecks(model, lay.items.map((e) => resolveItem(e, byId)));
  const m = r.metrics;
  console.log(`\n== ${lay.name}  (${Math.round(performance.now() - t)} ms) — ${m.errors} sorun, ${m.warnings} uyarı, en dar kapı yolu ${m.minPassage === null ? '-' : Math.round(m.minPassage)} cm`);
  for (const i of r.issues) console.log(`  ${{ error: 'SORUN', warn: 'UYARI', info: 'bilgi' }[i.severity].padEnd(5)}  ${i.text}`);
}
process.exit(failed ? 1 : 0);
