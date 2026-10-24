// Tek sayfalık önizleme: derlenmiş uygulamayı, CSS/JS'i ve bir veri setini içine gömerek tek HTML yapar
// (dosya okuyamayan / ayrı sunucusu olmayan barındırma için, ör. özel claude.ai sayfası).
//
//   npm run build && node scripts/build-artifact.mjs <veri-seti> <çıktı-klasörü> [başlık]
//
// Çıktı: <klasör>/index.html (gövde içeriği; doctype/head yok) + diğer JS parçaları (yanında yayınlanır).

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
const js = read(path.join(dist, 'assets', jsFile)).replace(/<\/script/gi, '<\\/script');
const css = read(path.join(dist, 'assets', cssFile));

const dir = path.join(data, set);
const catalog = fs.existsSync(path.join(dir, 'furniture.json')) ? json(path.join(dir, 'furniture.json')) : json(path.join(data, 'furniture.json'));
const idx = path.join(dir, 'layouts/index.json');
const layouts = fs.existsSync(idx) ? json(idx).layouts.map((f) => ({ id: f.replace(/\.json$/, ''), ...json(path.join(dir, 'layouts', f)) })) : [];
const payload = JSON.stringify({ plan: json(path.join(dir, 'plan.json')), catalog, layouts }).replace(/</g, '\\u003c');

fs.mkdirSync(outDir, { recursive: true });
const page = `<title>${title}</title>
<style>${css}</style>
${body.trim()}
<script>window.__EVPLAN_DATA__ = ${payload};</script>
<script type="module">${js}</script>
`;
fs.writeFileSync(path.join(outDir, 'index.html'), page);
// Kontrol işçisi ve sonradan yüklenen parçalar (gün ışığı, AO, foto, ortak three çekirdeği) sayfanın yanında yayınlanır.
const parts = fs.readdirSync(path.join(dist, 'assets')).filter((f) => f.endsWith('.js') && f !== jsFile);
for (const w of parts) fs.copyFileSync(path.join(dist, 'assets', w), path.join(outDir, w));
console.log(`${path.join(outDir, 'index.html')} (${(page.length / 1024).toFixed(0)} KB) + ${parts.join(', ')}`);
