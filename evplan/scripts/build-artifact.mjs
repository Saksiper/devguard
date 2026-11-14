// Önizleme sayfası: derlenmiş uygulamanın CSS'ini ve bir veri setini içine gömen HTML + yanında JS parçaları
// (dosya okuyamayan / ayrı sunucusu olmayan barındırma için, ör. özel claude.ai sayfası).
//
//   npm run build && node scripts/build-artifact.mjs <veri-seti> <çıktı-klasörü> [başlık]
//
// Çıktı: <klasör>/index.html (gövde içeriği; doctype/head yok) + JS parçaları (yanında yayınlanır).

import fs from 'node:fs';
import path from 'node:path';

const [, , set = 'ev', outDir, title = 'Ev Yerleşim'] = process.argv;
if (!outDir) {
  console.error('Kullanım: node scripts/build-artifact.mjs <veri-seti> <çıktı-klasörü> [başlık]');
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const data = path.join(root, 'public/data');
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (f) => JSON.parse(read(f));

const html = read(path.join(dist, 'index.html'));
const jsFile = html.match(/src="\.\/assets\/(index-[^"]+\.js)"/)[1];
const cssFile = html.match(/href="\.\/assets\/(index-[^"]+\.css)"/)[1];
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>')).replace(/<script[^>]*src=[^>]*><\/script>/g, '');
const css = read(path.join(dist, 'assets', cssFile));

const dir = path.join(data, set);
const catalog = fs.existsSync(path.join(dir, 'furniture.json')) ? json(path.join(dir, 'furniture.json')) : json(path.join(data, 'furniture.json'));
const idx = path.join(dir, 'layouts/index.json');
const layouts = fs.existsSync(idx) ? json(idx).layouts.map((f) => ({ id: f.replace(/\.json$/, ''), ...json(path.join(dir, 'layouts', f)) })) : [];
const plan = json(path.join(dir, 'plan.json'));
if (!plan.finishes && fs.existsSync(path.join(dir, 'finishes.json'))) plan.finishes = json(path.join(dir, 'finishes.json')); // gerçek kaplama renkleri
if (plan.finishes) plan.finishes._base = `./data/${set}/`;
const payload = JSON.stringify({ plan, catalog, layouts }).replace(/</g, '\\u003c');

fs.mkdirSync(outDir, { recursive: true });
const page = `<title>${title}</title>
<style>${css}</style>
${body.trim()}
<script>window.__EVPLAN_DATA__ = ${payload};</script>
<script type="module" src="./${jsFile}"></script>
`;
fs.writeFileSync(path.join(outDir, 'index.html'), page);
// Uygulama betiği, kontrol işçisi ve sonradan yüklenen parçalar (gün ışığı, AO, foto, ortak three çekirdeği)
// sayfanın yanında ayrı dosya olarak yayınlanır. Ana betik sayfaya gömülmez: parçalar ondan içe aktarım yapar
// ve aynı modül örneğini paylaşmaları gerekir.
const parts = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js'));
for (const w of parts) fs.copyFileSync(path.join(dist, 'assets', w), path.join(outDir, w));
// Halı desen haritaları (shape.map) da yanında, aynı göreli yolda (data/textures/…) yayınlanır.
const maps = [...new Set(catalog.items.map((c) => c.shape?.map).filter(Boolean))];
for (const m of maps) {
  fs.mkdirSync(path.dirname(path.join(outDir, 'data', m)), { recursive: true });
  fs.copyFileSync(path.join(data, m), path.join(outDir, 'data', m));
}
// Manzara arka planları (finishes.backdrops) veri setinin kendi klasöründe yayınlanır.
const views = (plan.finishes?.backdrops ?? []).map((b) => `${set}/${b.image}`);
for (const v of views) {
  fs.mkdirSync(path.dirname(path.join(outDir, 'data', v)), { recursive: true });
  fs.copyFileSync(path.join(data, v), path.join(outDir, 'data', v));
}
console.log(`${path.join(outDir, 'index.html')} (${(page.length / 1024).toFixed(0)} KB) + ${[...parts, ...[...maps, ...views].map((m) => `data/${m}`)].join(', ')}`);
