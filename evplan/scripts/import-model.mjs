// Komut satırı: node scripts/import-model.mjs <model.json> <çıktı-klasörü>
// Dönüşüm mantığı: src/core/importModel.js
import fs from 'node:fs';
import path from 'node:path';
import { convertModel } from '../src/core/importModel.js';

const [, , src, outDir] = process.argv;
if (!src || !outDir) {
  console.error('Kullanım: node scripts/import-model.mjs <model.json> <çıktı-klasörü>');
  process.exit(1);
}
const { plan, thin } = convertModel(JSON.parse(fs.readFileSync(src, 'utf8')), path.basename(src));
const { rooms, walls, openings, fixtures } = plan;
fs.mkdirSync(path.join(outDir, 'layouts'), { recursive: true });
fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 1) + '\n');
for (const t of thin) console.log('  not:', t);
console.log(
  `${rooms.length} oda, ${walls.length} duvar, ${openings.length} açıklık, ${fixtures.length} sabit engel → ${path.join(outDir, 'plan.json')}`,
);
