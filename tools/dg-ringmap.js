'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(
  os.homedir(),
  '.claude', 'plugins', 'data', 'devguard-devguard-marketplace', 'devguard.db',
);
const DEFAULT_OUT = path.join(REPO_ROOT, 'docs', 'devguard-ring-map.html');

const DB = process.argv[2] || process.env.DEVGUARD_DB || DEFAULT_DB;
const OUT = process.argv[3] || process.env.DEVGUARD_RINGMAP_OUT || DEFAULT_OUT;
const PROJECT_NAME = process.argv[4] || process.env.DEVGUARD_PROJECT_NAME || 'devguard';
const PROJECT_ROOT = process.argv[5] || process.env.DEVGUARD_PROJECT_ROOT || REPO_ROOT;
const EDGE_MIN_SESSIONS = 2;
const EDGE_TOP_N = 400;
const MAX_FILE_BYTES = 200 * 1024;

const SKIP_DIRS = new Set(['node_modules','.next','.venv','.git','dist','build','.cache','out','coverage','.turbo']);
const CODE_EXT = new Set(['ts','tsx','js','jsx','mjs','cjs','py']);

const isNoise = (f) => {
  if (!f) return true;
  const x = f.replace(/\\/g, '/');
  return x.includes('/AppData/Local/Temp/') || x.includes('/.claude/')
      || x.includes('/node_modules/') || x.includes('/.venv/') || x.includes('/.next/')
      || x.endsWith('.lock') || x.endsWith('.log');
};

function extractJS(content) {
  const lines = content.split('\n');
  const starts = [];
  const patterns = [
    /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*(\w+)/,
    /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=][^=]*?(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/,
  ];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 500) continue;
    for (const p of patterns) {
      const m = p.exec(lines[i]);
      if (m && m[1]) { starts.push({ line: i, name: m[1] }); break; }
    }
  }
  const seen = new Set();
  const dedup = starts.filter(s => {
    const k = s.line + ':' + s.name;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const rings = [];
  for (let i = 0; i < dedup.length; i++) {
    const end = (i + 1 < dedup.length) ? dedup[i+1].line - 1 : lines.length - 1;
    rings.push({ name: dedup[i].name, startLine: dedup[i].line + 1, endLine: end + 1 });
  }
  return rings;
}
function extractPython(content) {
  const lines = content.split('\n');
  const topLevel = [];
  const pattern = /^(\s*)(?:async\s+)?(?:def|class)\s+(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const m = pattern.exec(lines[i]);
    if (m && m[1].length === 0) topLevel.push({ line: i, name: m[2] });
  }
  const rings = [];
  for (let i = 0; i < topLevel.length; i++) {
    const end = (i + 1 < topLevel.length) ? topLevel[i+1].line - 1 : lines.length - 1;
    rings.push({ name: topLevel[i].name, startLine: topLevel[i].line + 1, endLine: end + 1 });
  }
  return rings;
}
function extractRings(filePath, content) {
  const ext = filePath.toLowerCase().split('.').pop();
  if (['ts','tsx','js','jsx','mjs','cjs'].includes(ext)) return extractJS(content);
  if (ext === 'py') return extractPython(content);
  return [];
}
function walkProject(root) {
  const out = [];
  function recurse(dir) {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        recurse(path.join(dir, e.name));
      } else if (e.isFile()) {
        const full = path.join(dir, e.name);
        const ext = e.name.toLowerCase().split('.').pop();
        if (!CODE_EXT.has(ext)) continue;
        try { if (fs.statSync(full).size > MAX_FILE_BYTES) continue; } catch { continue; }
        out.push(full);
      }
    }
  }
  recurse(root);
  return out;
}

console.log('Walking:', PROJECT_ROOT);
const codeFiles = walkProject(PROJECT_ROOT);
const fileRings = new Map();
for (const fp of codeFiles) {
  let c; try { c = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
  fileRings.set(fp.replace(/\\/g, '/'), extractRings(fp, c));
}

const db = new DatabaseSync(DB, { readOnly: true });
// protect_note may not exist on older DBs — query schema first
const hasProtectNote = db.prepare("PRAGMA table_info(changes)").all().some(c => c.name === 'protect_note');
const rows = db.prepare(`
  SELECT file, description, lines_start, lines_end, timestamp, action, session_id,
         claude_verdict, verdict_quality
         ${hasProtectNote ? ', protect_note' : ''}
  FROM changes
  WHERE REPLACE(project_path, '\\', '/') LIKE ?
    AND file IS NOT NULL
  ORDER BY timestamp
`).all('%' + PROJECT_NAME + '%');
const realRows = rows.filter(r => !isNoise(r.file));

function findOverlap(rings, s, e) {
  if (!s || !e || !rings || !rings.length) return [];
  return rings.filter(r => r.startLine <= e && s <= r.endLine);
}

const ringMap = new Map();
function getRing(file, name, startLine, endLine) {
  const id = file + '::' + name;
  if (!ringMap.has(id)) {
    ringMap.set(id, {
      id, file, name, short: name,
      dir: file.substring(0, file.lastIndexOf('/')).split('/').slice(-2).join('/'),
      fileShort: file.split('/').pop(),
      startLine, endLine,
      edits: 0, first: null, last: null, descriptions: [], sessions: new Set(),
    });
  }
  return ringMap.get(id);
}

function snapToNearest(rings, s, e) {
  if (!rings.length) return null;
  const mid = (s + (e || s)) / 2;
  let best = rings[0];
  let bestDist = Math.min(Math.abs(mid - best.startLine), Math.abs(mid - best.endLine));
  for (const ring of rings) {
    const d = Math.min(Math.abs(mid - ring.startLine), Math.abs(mid - ring.endLine));
    if (d < bestDist) { best = ring; bestDist = d; }
  }
  return best;
}

for (const r of realRows) {
  const f = r.file.replace(/\\/g, '/');
  const knownRings = fileRings.get(f) || [];
  const overlap = findOverlap(knownRings, r.lines_start, r.lines_end);
  let targets;
  if (overlap.length > 0) {
    // Edit bir veya daha fazla fonksiyonun aralığına düştü → o fonksiyon(lar)
    targets = overlap.map(o => getRing(f, o.name, o.startLine, o.endLine));
  } else if (knownRings.length > 0 && r.lines_start) {
    // Dosyada fonksiyon var ama edit dışına düşmüş → en yakın fonksiyona snap
    const near = snapToNearest(knownRings, r.lines_start, r.lines_end);
    targets = [getRing(f, near.name, near.startLine, near.endLine)];
  } else {
    // Kodsuz dosya (JSON/HTML/CSS/MD/...) veya fonksiyon hiç çıkarılamadı → tek file ring
    targets = [getRing(f, '__file__', 1, 999999)];
  }
  for (const ring of targets) {
    ring.edits++;
    if (!ring.first || r.timestamp < ring.first) ring.first = r.timestamp;
    if (!ring.last || r.timestamp > ring.last) ring.last = r.timestamp;
    // Push history entry — include claude_verdict (NEDEN) + protect_note (DOKUNMA)
    // when present. We keep entries even if description is empty, because verdict
    // alone is also valuable signal.
    const hasContent = (r.description && r.description.trim())
      || (r.claude_verdict && r.claude_verdict.trim())
      || (r.protect_note && r.protect_note.trim());
    if (hasContent) {
      ring.descriptions.push({
        ts: r.timestamp,
        desc: (r.description || '').replace(/[ \t]+/g, ' ').trim().slice(0, 4000),
        verdict: (r.claude_verdict || '').replace(/[ \t]+/g, ' ').trim().slice(0, 1200) || null,
        protect: (r.protect_note || '').trim().slice(0, 300) || null,
        quality: r.verdict_quality || 1,
        action: r.action,
        lines: (r.lines_start && r.lines_end) ? r.lines_start + '-' + r.lines_end : null,
      });
    }
    if (r.session_id) ring.sessions.add(r.session_id.slice(0, 8));
  }
}

const allRings = [...ringMap.values()].filter(r => r.edits > 0);
const nodes = allRings.map(r => ({
  id: r.id,
  short: r.name === '__file__' ? r.fileShort : r.name,
  isFileRing: r.name === '__file__',
  file: r.file, fileShort: r.fileShort, dir: r.dir,
  startLine: r.startLine, endLine: r.endLine,
  edits: r.edits, first: r.first, last: r.last,
  sessionCount: r.sessions.size,
  descriptions: r.descriptions.slice(-20),
  isDemo: r.descriptions.some(d => typeof d.desc === 'string' && d.desc.startsWith('[DG-DEMO')),
}));

const sessionRings = new Map();
const ringIdSet = new Set(nodes.map(n => n.id));
for (const r of realRows) {
  if (!r.session_id) continue;
  const f = r.file.replace(/\\/g, '/');
  const knownRings = fileRings.get(f) || [];
  const overlap = findOverlap(knownRings, r.lines_start, r.lines_end);
  const ss = r.session_id.slice(0, 8);
  if (!sessionRings.has(ss)) sessionRings.set(ss, new Set());
  const set = sessionRings.get(ss);
  if (overlap.length > 0) {
    for (const o of overlap) { const id = f + '::' + o.name; if (ringIdSet.has(id)) set.add(id); }
  } else if (knownRings.length > 0 && r.lines_start) {
    const near = snapToNearest(knownRings, r.lines_start, r.lines_end);
    const id = f + '::' + near.name; if (ringIdSet.has(id)) set.add(id);
  } else {
    const id = f + '::__file__'; if (ringIdSet.has(id)) set.add(id);
  }
}
const pairCounts = new Map();
for (const rs of sessionRings.values()) {
  const arr = [...rs].sort();
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const key = arr[i] + '|||' + arr[j];
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }
}
const links = [...pairCounts.entries()]
  .filter(([_, w]) => w >= EDGE_MIN_SESSIONS)
  .map(([key, w]) => { const [a, b] = key.split('|||'); return { source: a, target: b, weight: w }; })
  .sort((x, y) => y.weight - x.weight)
  .slice(0, EDGE_TOP_N);

function safeJsonForScript(obj) {
  // JSON.stringify escapes quotes but does NOT escape `</script>` or unicode
  // line/paragraph separators that break browser JS parsing. Patch those:
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  let s = JSON.stringify(obj).replace(/<\//g, '<\\/');
  s = s.split(LS).join('\\u2028').split(PS).join('\\u2029');
  return s;
}


const tsToMs = (s) => new Date(s.replace(' ', 'T') + 'Z').getTime();
const tsList = nodes.map(n => tsToMs(n.last));
const maxTs = tsList.length ? Math.max(...tsList) : Date.now();
const minTs = tsList.length ? Math.min(...tsList) : Date.now();

const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DevGuard Ring Map v4 — 3D Sphere</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<script src="https://unpkg.com/3d-force-graph@1.73.4/dist/3d-force-graph.min.js"
  onerror="document.body.innerHTML='<div style=\\'color:#ff5e58;padding:40px;font-family:monospace;font-size:14px\\'>3d-force-graph CDN YÜKLENMEDİ. Internet ya da CDN sorunu. Hata: script load failed.</div>'"></script>
<style>
  :root {
    --bg:#0a0b0f; --panel:#14161e; --panel-2:#1a1d27;
    --ink:#dcd9d0; --dim:#82869a; --line:#262935;
    --hot:#ec5d57; --warm:#d59f52; --cool:#5aa9be; --dead:#565a68;
    --accent:#5aa9be;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--bg);color:var(--ink);height:100%;overflow:hidden}
  body{
    font-family:'JetBrains Mono',monospace;font-size:12.5px;line-height:1.55;
  }
  .layout{display:grid;grid-template-columns:minmax(0,1fr) 460px;height:100vh;overflow:hidden}
  #map{width:100%;height:100%;background:#0a0b0f;position:relative}
  .panel{background:var(--panel);border-left:1px solid var(--line);overflow-y:auto;padding:24px 26px;transition:box-shadow .3s}
  .panel.flash{box-shadow:inset 4px 0 0 0 #5fc8e5,inset 0 0 60px rgba(95,200,229,.12);animation:flashPanel .9s ease-out}
  @keyframes flashPanel{
    0%{box-shadow:inset 8px 0 0 0 #ff34d6,inset 0 0 120px rgba(255,52,214,.3)}
    100%{box-shadow:inset 4px 0 0 0 #5fc8e5,inset 0 0 60px rgba(95,200,229,.0)}
  }
  .eyebrow{font-size:10px;letter-spacing:.3em;color:var(--accent);text-transform:uppercase}
  h1{font-family:'Archivo',sans-serif;font-weight:800;font-size:30px;letter-spacing:-.02em;margin:8px 0 4px;text-transform:uppercase}
  .subtitle{color:var(--dim);font-size:11px;letter-spacing:.04em;margin-bottom:24px}
  .legend{border:1px solid var(--line);padding:14px 16px;margin-bottom:20px;background:rgba(20,22,30,.5)}
  .legend h3{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin-bottom:10px}
  .legend-row{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--dim);margin:5px 0}
  .swatch{width:14px;height:14px;border-radius:50%;flex:none}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:24px}
  .stat{background:var(--panel-2);padding:11px 13px}
  .stat .n{font-family:'Archivo';font-weight:800;font-size:22px;letter-spacing:-.02em}
  .stat .k{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-top:4px}
  .placeholder{color:var(--dim);font-size:11.5px;line-height:1.7}
  .placeholder b{color:var(--ink)}
  .ring-name{font-family:'Archivo';font-weight:800;font-size:18px;word-break:break-all;letter-spacing:-.01em;margin-bottom:2px}
  .ring-dir{color:var(--dim);font-size:10.5px;margin-bottom:14px;word-break:break-all}
  .ring-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:18px}
  .ring-stats .s{background:var(--panel-2);padding:9px 11px}
  .ring-stats .v{font-family:'Archivo';font-weight:700;font-size:16px}
  .ring-stats .l{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-top:3px}
  .hist-header{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin:18px 0 10px}
  .hist-entry{border-left:2px solid var(--line);padding:8px 0 8px 12px;margin-bottom:10px}
  .hist-ts{font-size:10px;color:var(--dim);letter-spacing:.04em}
  .hist-meta{font-size:10px;color:var(--dim);margin-left:8px}
  .hist-meta .tag{color:var(--warm)}
  .hist-desc{font-size:11.5px;color:var(--ink);margin-top:5px;line-height:1.55;word-break:break-word}
  .neighbor-list{display:flex;flex-direction:column;gap:5px;margin-top:8px}
  .neighbor{display:flex;justify-content:space-between;font-size:11px;padding:4px 8px;border:1px solid var(--line);background:var(--panel-2);cursor:pointer;transition:.15s}
  .neighbor:hover{border-color:var(--accent);background:rgba(90,169,190,.07)}
  .neighbor .nb-name{color:var(--ink);word-break:break-all;flex:1;padding-right:8px}
  .neighbor .nb-w{color:var(--accent);font-weight:700;font-family:'Archivo'}
  .top-bar{position:absolute;top:18px;left:22px;font-family:'JetBrains Mono';font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);pointer-events:none;z-index:10;text-shadow:0 0 4px #0a0b0f}
  .top-bar b{color:var(--accent)}
  .controls-hint{position:absolute;bottom:16px;left:22px;font-size:10px;color:var(--dim);background:rgba(20,22,30,.7);border:1px solid var(--line);padding:6px 10px;pointer-events:none;z-index:10}
  .controls-hint b{color:var(--accent)}
  #dg-tooltip{
    position:fixed;display:none;z-index:100;
    background:#14161e;color:#dcd9d0;border:1px solid #2c3040;
    padding:0;font-family:'JetBrains Mono',monospace;font-size:11px;
    width:480px;max-height:520px;overflow:hidden;
    box-shadow:0 12px 40px rgba(0,0,0,.6),0 0 0 1px rgba(95,200,229,.15);
    pointer-events:auto;
  }
  #dg-tooltip .tt-head{padding:11px 14px 9px;border-bottom:1px solid #262935;background:#1a1d27}
  #dg-tooltip .tt-name{font-family:'Archivo';font-weight:800;font-size:15px;color:#dcd9d0;word-break:break-all;letter-spacing:-.01em}
  #dg-tooltip .tt-meta{color:#82869a;font-size:10px;margin-top:3px;word-break:break-all}
  #dg-tooltip .tt-meta .tag{color:#5fc8e5}
  #dg-tooltip .tt-meta .demo{color:#ff34d6;font-weight:700}
  #dg-tooltip .tt-stats{display:flex;gap:18px;margin-top:8px;font-size:10px;color:#a0a4b0}
  #dg-tooltip .tt-stats b{color:#dcd9d0;font-family:'Archivo';font-size:13px;margin-right:3px}
  #dg-tooltip .tt-body{padding:10px 14px 14px;overflow-y:auto;max-height:380px}
  #dg-tooltip .tt-section{font-size:9px;letter-spacing:.22em;color:#5fc8e5;text-transform:uppercase;margin:0 0 6px}
  #dg-tooltip .tt-entry{border-left:2px solid #262935;padding:6px 0 6px 10px;margin-bottom:8px}
  #dg-tooltip .tt-entry .ts{color:#82869a;font-size:10px}
  #dg-tooltip .tt-entry .tag{color:#ffb046;font-size:10px;margin-left:6px}
  #dg-tooltip .tt-entry .desc{color:#dcd9d0;font-size:11px;line-height:1.55;margin-top:4px;white-space:pre-wrap;word-break:break-word}
  #dg-tooltip .ent-section{margin-top:6px;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word;padding-left:8px;border-left:2px solid #2c3040}
  #dg-tooltip .ent-section .ent-label{display:inline-block;font-size:8.5px;letter-spacing:.22em;font-weight:700;margin-right:7px;padding:1px 6px;border-radius:2px}
  #dg-tooltip .ent-neden{color:#dcd9d0;border-left-color:#5fc8e5}
  #dg-tooltip .ent-neden .ent-label{background:#5fc8e5;color:#14161e}
  #dg-tooltip .ent-dokunma{color:#ffd4c8;border-left-color:#ffb046}
  #dg-tooltip .ent-dokunma .ent-label{background:#ffb046;color:#14161e}
  #dg-tooltip .ent-kod{color:#9aa0b0;border-left-color:#3a3f50}
  #dg-tooltip .ent-kod .ent-label{background:#3a3f50;color:#dcd9d0}
  #dg-tooltip .ent-kod code{display:block;margin-top:3px;font-family:'JetBrains Mono',monospace;font-size:10px;color:#a0a4b0}
  #dg-tooltip .tt-foot{padding:9px 14px;border-top:1px solid #262935;background:#1a1d27;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#82869a}
  #dg-tooltip .tt-foot button{background:transparent;border:1px solid #2c3040;color:#5fc8e5;font-family:'JetBrains Mono',monospace;font-size:10px;padding:5px 10px;cursor:pointer;letter-spacing:.1em;text-transform:uppercase}
  #dg-tooltip .tt-foot button:hover{background:rgba(95,200,229,.1);border-color:#5fc8e5}
  #dg-tooltip::-webkit-scrollbar,#dg-tooltip .tt-body::-webkit-scrollbar{width:6px}
  #dg-tooltip .tt-body::-webkit-scrollbar-thumb{background:#2c3040;border-radius:3px}
  #dg-tooltip .tt-body::-webkit-scrollbar-track{background:transparent}
</style>
</head>
<body>
<div class="layout">
  <div id="map">
    <div class="top-bar">DEVGUARD <b>RING MAP v4</b> · 3D · <span id="proj-label"></span></div>
    <div class="controls-hint">🖱 sürükle: <b>döndür</b> · scroll: <b>zoom</b> · sağ-tık sürükle: <b>kaydır</b> · halkaya hover: <b>kutu açılır</b> · tıkla: <b>tam panel</b></div>
  </div>
  <div id="dg-tooltip"></div>
  <aside class="panel">
    <div class="eyebrow">DevGuard · v4 — 3D</div>
    <h1>Ring Map</h1>
    <div class="subtitle">3D küre. Function-grain + co-change. Mouse ile döndür.</div>
    <div class="legend">
      <h3>Legend</h3>
      <div class="legend-row"><i class="swatch" style="background:var(--hot)"></i> Son 7 gün</div>
      <div class="legend-row"><i class="swatch" style="background:var(--warm)"></i> 7-30 gün</div>
      <div class="legend-row"><i class="swatch" style="background:var(--cool)"></i> 30-60 gün</div>
      <div class="legend-row"><i class="swatch" style="background:var(--dead)"></i> 60+ gün</div>
      <div class="legend-row" style="margin-top:8px"><i class="swatch" style="background:#ff34d6"></i> Demo (zenginleştirilmiş)</div>
      <div class="legend-row"><i class="swatch" style="background:transparent;border:2px solid var(--accent)"></i> Boyut = edit sayısı</div>
      <div class="legend-row"><i class="swatch" style="background:transparent;border:2px solid var(--dim);opacity:.5"></i> Tek-halka = kod-dışı dosya</div>
    </div>
    <div class="stats" id="stats"></div>
    <div id="detail" class="placeholder">
      <p><b>3D küre.</b> Function-grain halkalar + co-change kenarları. Sürükle, döndür, arkadakileri keşfet.</p>
      <p style="margin-top:10px">Halkaya tıkla → geçmiş + bağlı halkalar.</p>
    </div>
  </aside>
</div>

<script>
const DATA = ${safeJsonForScript({ nodes, links, maxTs, minTs, project: PROJECT_NAME, totalChanges: realRows.length, totalRings: nodes.length, fileRingCount: nodes.filter(n => n.isFileRing).length })};

// Surface any uncaught JS errors on the screen so we can debug
window.addEventListener('error', (e) => {
  const div = document.createElement('div');
  div.style.cssText = 'position:fixed;top:60px;left:20px;background:#1a1d27;color:#ff5e58;border:1px solid #ff5e58;padding:12px 16px;font-family:JetBrains Mono,monospace;font-size:12px;max-width:80%;z-index:9999;white-space:pre-wrap';
  div.textContent = 'JS ERROR: ' + e.message + '\\nat ' + (e.filename||'?') + ':' + e.lineno + ':' + e.colno;
  document.body.appendChild(div);
});

if (typeof ForceGraph3D === 'undefined') {
  document.body.innerHTML = '<div style="color:#ff5e58;padding:40px;font-family:monospace;font-size:14px">ForceGraph3D yüklenmedi. CDN problemli.</div>';
  throw new Error('ForceGraph3D undefined');
}

document.getElementById('proj-label').textContent = DATA.project;

const NOW = DATA.maxTs;
const D = 24 * 3600 * 1000;
function colorHexFor(n) {
  if (n.isDemo) return '#ff34d6';          // DEMO — bright magenta
  const t = new Date(n.last.replace(' ', 'T') + 'Z').getTime();
  const daysAgo = (NOW - t) / D;
  let c;
  if (daysAgo <= 7) c = '#ff5e58';        // hot — daha parlak kırmızı
  else if (daysAgo <= 30) c = '#ffb046';   // warm — parlak amber
  else if (daysAgo <= 60) c = '#5fc8e5';   // cool — parlak cyan
  else c = '#9aa0b0';                      // dead — açık gri, bg'den ayrılsın
  return c;
}

const stats = [
  { n: DATA.totalRings, k: 'Halka' },
  { n: DATA.fileRingCount, k: 'Kod-dışı dosya' },
  { n: DATA.links.length, k: 'Edge' },
  { n: DATA.totalChanges, k: 'Edit' },
];
document.getElementById('stats').innerHTML = stats.map(s =>
  '<div class="stat"><div class="n">' + s.n + '</div><div class="k">' + s.k + '</div></div>'
).join('');

const elem = document.getElementById('map');
const Graph = ForceGraph3D()(elem)
  .backgroundColor('#14161e')                  // biraz daha açık bg, nodelar bg'den ayrılsın
  .graphData({ nodes: DATA.nodes, links: DATA.links })
  .nodeId('id')
  .nodeRelSize(6)
  .nodeVal(d => d.isDemo ? 60 : Math.max(2, d.edits))
  .nodeColor(d => colorHexFor(d))
  .nodeOpacity(0.95)
  .nodeResolution(14)
  .nodeLabel(() => '')
  .linkColor(() => '#8590a0')
  .linkWidth(d => Math.min(3, Math.sqrt(d.weight) * 0.8))
  .linkOpacity(0.6)
  .linkDirectionalParticles(0)
  .onNodeClick(d => {
    showDetail(d);
    const distance = 140;
    const distRatio = 1 + distance / Math.hypot(d.x || 1, d.y || 1, d.z || 1);
    Graph.cameraPosition(
      { x: (d.x || 0) * distRatio, y: (d.y || 0) * distRatio, z: (d.z || 0) * distRatio },
      d,
      1500
    );
  });

// Resize handling
window.addEventListener('resize', () => {
  Graph.width(elem.clientWidth).height(elem.clientHeight);
});
Graph.width(elem.clientWidth).height(elem.clientHeight);

// --- Sticky tooltip ---
const tooltip = document.getElementById('dg-tooltip');
let mouseX = 0, mouseY = 0;
let hideTimer = null;
let currentNode = null;

function escTip(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderTooltip(d) {
  const ring = d.isFileRing ? '[file]' : '[function]';
  const lines = d.isFileRing ? '' : ' L' + d.startLine + '-' + d.endLine;
  const demoBadge = d.isDemo ? ' <span class="demo">[DEMO]</span>' : '';
  const all = (d.descriptions || []).slice().reverse();
  const entriesHtml = all.length > 0
    ? all.map(h => {
        const ts = h.ts ? h.ts.slice(0,16) : '';
        const tag = h.lines ? '<span class="tag">L' + h.lines + '</span>' : '';
        const action = h.action ? '<span class="tag">' + escTip(h.action) + '</span>' : '';
        const verdictBlock = h.verdict
          ? '<div class="ent-section ent-neden"><span class="ent-label">NEDEN</span>' + escTip(h.verdict) + '</div>'
          : '';
        const protectBlock = h.protect
          ? '<div class="ent-section ent-dokunma"><span class="ent-label">DOKUNMA</span>' + escTip(h.protect) + '</div>'
          : '';
        const codeBlock = h.desc
          ? '<div class="ent-section ent-kod"><span class="ent-label">KOD</span><code>' + escTip(h.desc.slice(0, 240)) + (h.desc.length > 240 ? '…' : '') + '</code></div>'
          : '';
        return '<div class="tt-entry">' +
          '<span class="ts">' + ts + '</span>' + action + tag +
          verdictBlock + protectBlock + codeBlock +
        '</div>';
      }).join('')
    : '<div style="color:#82869a;font-size:11px"><em>description kaydı yok.</em></div>';

  tooltip.innerHTML =
    '<div class="tt-head">' +
      '<div class="tt-name">' + escTip(d.short) + ' <span class="tag" style="color:#5fc8e5">' + ring + '</span>' + demoBadge + '</div>' +
      '<div class="tt-meta">' + escTip(d.dir + '/' + d.fileShort + lines) + '</div>' +
      '<div class="tt-stats">' +
        '<span><b>' + d.edits + '</b>edit</span>' +
        '<span><b>' + d.sessionCount + '</b>oturum</span>' +
        '<span><b>' + (d.last ? d.last.slice(0,10) : '—') + '</b>son</span>' +
      '</div>' +
    '</div>' +
    '<div class="tt-body">' +
      '<div class="tt-section">Tüm description geçmişi (' + all.length + ')</div>' +
      entriesHtml +
    '</div>' +
    '<div class="tt-foot">' +
      '<span>fareyi içine al · scroll et · oku</span>' +
      '<button data-action="open-panel">YAN PANELE AÇ →</button>' +
    '</div>';

  const btn = tooltip.querySelector('button[data-action="open-panel"]');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      showDetail(d);
      flashPanel();
      const panel = document.querySelector('.panel');
      if (panel) panel.scrollTop = 0;
      const orig = btn.textContent;
      btn.textContent = 'AÇILDI ✓';
      btn.style.color = '#ff34d6';
      setTimeout(() => {
        hideTooltip();
        const x = d.x || 0, y = d.y || 0, z = d.z || 0;
        const distance = 140;
        const distRatio = 1 + distance / (Math.hypot(x, y, z) || 1);
        Graph.cameraPosition({ x: x * distRatio, y: y * distRatio, z: z * distRatio }, d, 1500);
      }, 400);
    });
  }
}

function flashPanel() {
  const panel = document.querySelector('.panel');
  if (!panel) return;
  panel.classList.remove('flash');
  void panel.offsetWidth;
  panel.classList.add('flash');
}

function showTooltipAt(d) {
  currentNode = d;
  renderTooltip(d);
  positionTooltip();
  tooltip.style.display = 'block';
}

function positionTooltip() {
  const w = 480, h = Math.min(520, tooltip.offsetHeight || 520);
  let left = mouseX + 22;
  let top = mouseY + 16;
  if (left + w + 12 > window.innerWidth) left = mouseX - w - 22;
  if (top + h + 12 > window.innerHeight) top = window.innerHeight - h - 12;
  if (top < 12) top = 12;
  if (left < 12) left = 12;
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}

function hideTooltip() {
  tooltip.style.display = 'none';
  currentNode = null;
}

function scheduleHide() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(hideTooltip, 350);
}

function cancelHide() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

elem.addEventListener('mousemove', (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
});

Graph.onNodeHover((node) => {
  cancelHide();
  if (node) {
    showTooltipAt(node);
    elem.style.cursor = 'pointer';
  } else {
    elem.style.cursor = 'default';
    scheduleHide();
  }
});

tooltip.addEventListener('mouseenter', cancelHide);
tooltip.addEventListener('mouseleave', scheduleHide);

// Zoom-to-demo button: kullanıcı tetikler, kamera sahnenin ortasında doğmuş halde kalmaz
const demoNode = DATA.nodes.find(n => n.isDemo);
if (demoNode) {
  const btnZoom = document.createElement('button');
  btnZoom.textContent = '🎯 Demo halkaya zoom';
  btnZoom.style.cssText = 'position:absolute;top:18px;right:18px;z-index:20;background:rgba(20,22,30,.85);border:1px solid #ff34d6;color:#ff34d6;font-family:JetBrains Mono,monospace;font-size:11px;padding:7px 12px;cursor:pointer;letter-spacing:.1em;text-transform:uppercase';
  btnZoom.addEventListener('click', () => {
    const x = demoNode.x || 0, y = demoNode.y || 0, z = demoNode.z || 0;
    const dist = 200;
    const len = Math.hypot(x, y, z) || 1;
    const r = 1 + dist / len;
    Graph.cameraPosition({ x: x * r, y: y * r, z: z * r }, demoNode, 1800);
    setTimeout(() => { showDetail(demoNode); flashPanel(); }, 2000);
  });
  elem.appendChild(btnZoom);
}

const nodeIndex = new Map(DATA.nodes.map(n => [n.id, n]));

function showDetail(d) {
  const det = document.getElementById('detail');
  det.classList.remove('placeholder');
  const dateStr = (s) => s ? s.slice(0,10) : '—';

  const histRows = d.descriptions.slice().reverse().map(h => {
    const lines = h.lines ? '<span class="tag">L' + h.lines + '</span>' : '';
    const action = h.action ? '<span class="tag">' + h.action + '</span>' : '';
    return '<div class="hist-entry">' +
      '<span class="hist-ts">' + (h.ts ? h.ts.slice(0,16) : '') + '</span>' +
      '<span class="hist-meta">' + action + ' ' + lines + '</span>' +
      '<div class="hist-desc">' + escapeHtml(h.desc) + '</div>' +
    '</div>';
  }).join('');

  const neighbors = [];
  for (const l of DATA.links) {
    const sid = (typeof l.source === 'object') ? l.source.id : l.source;
    const tid = (typeof l.target === 'object') ? l.target.id : l.target;
    if (sid === d.id) neighbors.push({ id: tid, w: l.weight });
    else if (tid === d.id) neighbors.push({ id: sid, w: l.weight });
  }
  neighbors.sort((a,b) => b.w - a.w);

  const neighborsHtml = neighbors.length === 0
    ? '<div class="placeholder" style="font-size:11px"><em>Bağlı halka yok.</em></div>'
    : '<div class="neighbor-list">' + neighbors.slice(0, 10).map(n => {
        const nb = nodeIndex.get(n.id);
        const label = nb ? (nb.short + (nb.isFileRing ? '' : ' · ' + nb.fileShort)) : n.id.split('::').pop();
        return '<div class="neighbor" data-id="' + escapeHtml(n.id) + '">' +
          '<span class="nb-name">' + escapeHtml(label) + '</span>' +
          '<span class="nb-w">×' + n.w + '</span>' +
        '</div>';
      }).join('') + '</div>';

  const ringType = d.isFileRing ? '[file-level fallback]' : '[function/class]';
  const lineInfo = d.isFileRing ? '' : ' · L' + d.startLine + '-' + d.endLine;

  det.innerHTML =
    '<div class="ring-name">' + escapeHtml(d.short) + '</div>' +
    '<div class="ring-dir">' + escapeHtml(d.dir) + '/' + escapeHtml(d.fileShort) + lineInfo + ' <span style="color:var(--accent)">' + ringType + '</span></div>' +
    '<div class="ring-stats">' +
      '<div class="s"><div class="v">' + d.edits + '</div><div class="l">Edit</div></div>' +
      '<div class="s"><div class="v">' + d.sessionCount + '</div><div class="l">Oturum</div></div>' +
      '<div class="s"><div class="v">' + dateStr(d.last) + '</div><div class="l">Son</div></div>' +
    '</div>' +
    '<div class="hist-header">Co-change (' + neighbors.length + ')</div>' +
    neighborsHtml +
    '<div class="hist-header" style="margin-top:22px">Geçmiş (' + d.descriptions.length + ' kayıt, son 20)</div>' +
    (histRows || '<div class="placeholder" style="font-size:11px"><em>Description kaydı yok.</em></div>');

  det.querySelectorAll('.neighbor').forEach(el => {
    el.addEventListener('click', () => {
      const targetId = el.getAttribute('data-id');
      const targetNode = DATA.nodes.find(n => n.id === targetId);
      if (targetNode) showDetail(targetNode);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html);
console.log('wrote', OUT);
console.log('display nodes:', nodes.length, '(function:', nodes.filter(n => !n.isFileRing).length, ', file-fallback:', nodes.filter(n => n.isFileRing).length, ')');
console.log('display edges:', links.length);
db.close();
