'use strict';
// DevGuard Sphere Map (S5) — feature-grain continent/country visual map.
//
// Rendering pattern: 3d-force-graph CDN, safeJsonForScript, sticky tooltip, side
// panel. The graph is built from the V15 `features` table:
//   continent = domain (color/region), country = feature node (sized by edits),
//   edge = semantic neighbor over centroid_embedding, tooltip = layered note chain.
//
// The data functions (buildFeatureNodes / buildNeighborEdges / buildNoteChain) are
// pure-ish: they take a project-scoped db proxy (or plain rows) and return plain
// objects, so they are unit-testable without loading MiniLM. renderHtml is eye-verified.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { cosineSimilarity } = require('../src/engine/embedding');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DB = path.join(
  os.homedir(),
  '.claude', 'plugins', 'data', 'devguard-devguard-marketplace', 'devguard.db',
);
const DEFAULT_OUT = path.join(REPO_ROOT, 'docs', 'devguard-sphere-map.html');
const EDGE_THRESHOLD = 0.5;
const EDGE_TOP_N = 400;

// Fixed 8 continents → stable colors (mirrors node-taxonomy.CONTINENTS).
const CONTINENT_COLOR = {
  ui_ux: '#5fc8e5',
  security: '#ff5e58',
  data: '#ffb046',
  logic: '#a78bfa',
  infra: '#4ade80',
  math: '#f472b6',
  test: '#facc15',
  docs: '#94a3b8',
};

// 1. One node per features row. editCount from changes grouped by node_id, noteCount
//    from notes by node_id. continent drives color/group.
function buildFeatureNodes(db) {
  const features = db.getAllFeatures();
  if (!features.length) return [];

  const editCounts = new Map();
  for (const c of db.getChanges()) {
    if (!c.node_id) continue;
    editCounts.set(c.node_id, (editCounts.get(c.node_id) || 0) + 1);
  }

  return features.map((f) => ({
    node_id: f.node_id,
    continent: f.continent,
    country: f.country,
    memberCount: f.member_count,
    editCount: editCounts.get(f.node_id) || 0,
    noteCount: db.getNotesByNode(f.node_id).length,
    lastActivity: f.updated_at,
  }));
}

// 2. Neighbor edges over feature centroid buffers. rows: [{ node_id, centroid_embedding }].
//    No self-edge, undirected pairs deduped, above threshold, sorted desc, capped topN.
//    Deterministic: pairs are normalized so source < target lexically, then sorted by
//    (weight desc, source asc, target asc) so equal-weight ties have a stable order.
function buildNeighborEdges(rows, threshold = EDGE_THRESHOLD, topN = EDGE_TOP_N) {
  const withCentroid = rows.filter((r) => r.centroid_embedding);
  const edges = [];
  for (let i = 0; i < withCentroid.length; i++) {
    for (let j = i + 1; j < withCentroid.length; j++) {
      const sim = cosineSimilarity(withCentroid[i].centroid_embedding, withCentroid[j].centroid_embedding);
      if (sim < threshold) continue;
      let source = withCentroid[i].node_id;
      let target = withCentroid[j].node_id;
      if (source > target) [source, target] = [target, source];
      edges.push({ source, target, weight: sim });
    }
  }
  edges.sort((a, b) =>
    b.weight - a.weight
    || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)
    || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return edges.slice(0, topN);
}

// 3. Ordered layer history for a node: head first, then superseded ancestors, by
//    walking superseded_by backwards (older notes point superseded_by → newer head).
//    Forked history is real (supersedePriorHead collapses MANY prior heads onto one
//    head at once — degraded/orphan-heal), so a node can have several predecessors
//    per hop. Collect ALL of them via BFS; a single-predecessor walk would silently
//    drop sibling layers. `all` is newest-first, so predecessors surface newest-first.
function buildNoteChain(db, nodeId) {
  const head = db.getHeadNoteByNode(nodeId);
  if (!head) return [];
  const all = db.getNotesByNode(nodeId);
  const chain = [head];
  // Guard against a cycle in malformed data with a visited set.
  const seen = new Set([head.id]);
  const queue = [head];
  while (queue.length) {
    const current = queue.shift();
    for (const pred of all.filter((n) => n.superseded_by === current.id && !seen.has(n.id))) {
      chain.push(pred);
      seen.add(pred.id);
      queue.push(pred);
    }
  }
  return chain.map((n, i) => ({
    noteId: n.id,
    text: n.note_text,
    createdAt: n.created_at,
    isHead: i === 0,
  }));
}

// JSON.stringify escapes quotes but not `</script>` or U+2028/2029, which break the
// browser JS parser inside a <script> block. Patch those.
function safeJsonForScript(obj) {
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  let s = JSON.stringify(obj).replace(/<\//g, '<\\/');
  s = s.split(LS).join('\\u2028').split(PS).join('\\u2029');
  return s;
}

function renderHtml({ nodes = [], edges = [], chainsByNode = {}, project = 'devguard' }, out = DEFAULT_OUT) {
  const continents = [...new Set(nodes.map((n) => n.continent))].sort();
  const stats = {
    features: nodes.length,
    edges: edges.length,
    continents: continents.length,
    edits: nodes.reduce((s, n) => s + (n.editCount || 0), 0),
  };
  const DATA = { nodes, edges, chainsByNode, project, continents, stats, colors: CONTINENT_COLOR };

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DevGuard Sphere Map — ${project}</title>
<script src="https://unpkg.com/3d-force-graph@1.73.4/dist/3d-force-graph.min.js"
  onerror="document.body.innerHTML='<div style=\\'color:#ff5e58;padding:40px;font-family:monospace\\'>3d-force-graph CDN failed to load.</div>'"></script>
<style>
  :root{--bg:#0a0b0f;--panel:#14161e;--panel-2:#1a1d27;--ink:#dcd9d0;--dim:#82869a;--line:#262935;--accent:#5aa9be}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:var(--bg);color:var(--ink);height:100%;overflow:hidden}
  body{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:12.5px;line-height:1.55}
  .layout{display:grid;grid-template-columns:minmax(0,1fr) 440px;height:100vh;overflow:hidden}
  #map{width:100%;height:100%;background:#0a0b0f;position:relative}
  .panel{background:var(--panel);border-left:1px solid var(--line);overflow-y:auto;padding:22px 24px}
  .eyebrow{font-size:10px;letter-spacing:.3em;color:var(--accent);text-transform:uppercase}
  h1{font-weight:800;font-size:26px;letter-spacing:-.02em;margin:8px 0 4px;text-transform:uppercase}
  .subtitle{color:var(--dim);font-size:11px;margin-bottom:20px}
  .stats{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:20px}
  .stat{background:var(--panel-2);padding:11px 13px}
  .stat .n{font-weight:800;font-size:22px}
  .stat .k{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-top:4px}
  .legend{border:1px solid var(--line);padding:12px 14px;margin-bottom:20px;background:rgba(20,22,30,.5)}
  .legend h3{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin-bottom:10px}
  .legend-row{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--dim);margin:5px 0}
  .swatch{width:13px;height:13px;border-radius:50%;flex:none}
  .placeholder{color:var(--dim);font-size:11.5px;line-height:1.7}
  .ctry-name{font-weight:800;font-size:18px;word-break:break-all;margin-bottom:2px}
  .ctry-cont{color:var(--dim);font-size:10.5px;margin-bottom:14px}
  .ctry-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:var(--line);border:1px solid var(--line);margin-bottom:18px}
  .ctry-stats .s{background:var(--panel-2);padding:9px 11px}
  .ctry-stats .v{font-weight:700;font-size:16px}
  .ctry-stats .l{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-top:3px}
  .hist-header{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin:18px 0 10px}
  .layer{border-left:2px solid var(--line);padding:7px 0 7px 12px;margin-bottom:9px}
  .layer.head{border-left-color:var(--accent)}
  .layer .tag{font-size:9px;letter-spacing:.14em;color:var(--accent);text-transform:uppercase}
  .layer .txt{font-size:11.5px;color:var(--ink);margin-top:4px;white-space:pre-wrap;word-break:break-word}
  .layer .ts{font-size:10px;color:var(--dim);margin-top:3px}
  .top-bar{position:absolute;top:16px;left:20px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);pointer-events:none;z-index:10}
  .top-bar b{color:var(--accent)}
  .search{width:100%;background:var(--panel-2);border:1px solid var(--line);color:var(--ink);padding:9px 11px;font:inherit;font-size:11.5px;margin-bottom:18px}
  .search:focus{outline:none;border-color:var(--accent)}
  .search::placeholder{color:var(--dim)}
  .legend-row{cursor:pointer;user-select:none}
  .legend-row.off{opacity:.4}
  .legend-row.off .swatch{filter:grayscale(1)}
  .legend .hint{font-size:9px;color:var(--dim);margin-top:8px;letter-spacing:.05em}
  .nbr-header{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);margin:18px 0 8px}
  .nbr{display:block;width:100%;text-align:left;background:var(--panel-2);border:1px solid var(--line);color:var(--ink);padding:6px 10px;margin:4px 0;font:inherit;font-size:11px;cursor:pointer}
  .nbr:hover{border-color:var(--accent)}
  .nbr .w{color:var(--dim);float:right}
</style>
</head>
<body>
<div class="layout">
  <div id="map"><div class="top-bar">DEVGUARD <b>SPHERE MAP</b> · <span id="proj-label"></span></div></div>
  <aside class="panel">
    <div class="eyebrow">DevGuard · S5</div>
    <h1>Sphere Map</h1>
    <div class="subtitle">Continent = domain, country = feature. Size = edits. Edge = semantic neighbor.</div>
    <input id="search" class="search" placeholder="Search: feature / country…" autocomplete="off" spellcheck="false" />
    <div class="stats" id="stats"></div>
    <div class="legend"><h3>Continents</h3><div id="legend-rows"></div><div class="hint">Click a continent to show/hide</div></div>
    <div id="detail" class="placeholder"><p>Click a <b>country</b> (feature) → layered note history.</p></div>
  </aside>
</div>
<script>
const DATA = ${safeJsonForScript(DATA)};
var Graph = null;
document.getElementById('proj-label').textContent = DATA.project;

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function colorFor(c){return DATA.colors[c] || '#9aa0b0';}

document.getElementById('stats').innerHTML = [
  ['Features', DATA.stats.features],['Continents', DATA.stats.continents],
  ['Edges', DATA.stats.edges],['Edits', DATA.stats.edits],
].map(function(s){return '<div class="stat"><div class="n">'+s[1]+'</div><div class="k">'+s[0]+'</div></div>';}).join('');

var hiddenContinents = {};
var searchTerm = '';
function renderLegend(){
  document.getElementById('legend-rows').innerHTML = DATA.continents.length
    ? DATA.continents.map(function(c){var off=hiddenContinents[c]?' off':'';return '<div class="legend-row'+off+'" data-cont="'+esc(c)+'"><i class="swatch" style="background:'+colorFor(c)+'"></i>'+esc(c)+'</div>';}).join('')
    : '<div class="legend-row">No features yet.</div>';
}
renderLegend();
// A node is visible when its continent isn't toggled off AND (no search OR it matches).
function nodeMatches(n){
  if (hiddenContinents[n.continent]) return false;
  if (!searchTerm) return true;
  return ((n.node_id||'')+' '+(n.country||'')).toLowerCase().indexOf(searchTerm) !== -1;
}
function linkVis(l){
  var s = (l.source && typeof l.source==='object') ? l.source : null;
  var t = (l.target && typeof l.target==='object') ? l.target : null;
  return (!s || nodeMatches(s)) && (!t || nodeMatches(t));
}
function applyFilter(){ if (Graph) Graph.nodeVisibility(nodeMatches).linkVisibility(linkVis); }

if (typeof ForceGraph3D === 'undefined') {
  document.getElementById('map').innerHTML = '<div style="color:#ff5e58;padding:40px">ForceGraph3D failed to load (CDN).</div>';
} else {
  const elem = document.getElementById('map');
  Graph = ForceGraph3D()(elem)
    .backgroundColor('#0a0b0f')
    .graphData({ nodes: DATA.nodes.map(function(n){return Object.assign({ id: n.node_id }, n);}), links: DATA.edges.slice() })
    .nodeId('id')
    .nodeRelSize(6)
    .nodeVal(function(d){return Math.max(2, (d.editCount||0) + (d.memberCount||0));})
    .nodeColor(function(d){return colorFor(d.continent);})
    .nodeLabel(function(d){return esc(d.node_id)+' · '+(d.editCount||0)+' edit';})
    .linkColor(function(){return '#8590a0';})
    .linkWidth(function(d){return Math.min(3, (d.weight||0)*3);})
    .linkOpacity(0.5)
    .nodeVisibility(nodeMatches)
    .linkVisibility(linkVis)
    .onNodeClick(showDetail);

  // Codag-inspired: SEPARATE continents into regions. Force-directed alone mixes all
  // countries together; pinning each continent to a fixed 3D center and pulling its
  // countries toward it gives a "world map" feel — continents are distinct regions,
  // countries spread within a continent by semantic neighbor. Centers sit on a circle
  // (alternating y for a 3D look).
  var CONTINENTS = Object.keys(DATA.colors);
  var CR = 260, CPOS = {};
  CONTINENTS.forEach(function(c, i){
    var a = (i / CONTINENTS.length) * 2 * Math.PI;
    CPOS[c] = { x: CR * Math.cos(a), y: (i % 2 ? 120 : -120), z: CR * Math.sin(a) };
  });
  function continentForce(){
    var ns;
    function f(alpha){
      for (var k = 0; k < ns.length; k++){
        var n = ns[k], c = CPOS[n.continent];
        if (!c) continue;
        var s = alpha * 0.22;
        n.vx += (c.x - n.x) * s; n.vy += (c.y - n.y) * s; n.vz += (c.z - n.z) * s;
      }
    }
    f.initialize = function(_){ ns = _; };
    return f;
  }
  Graph.d3Force('continent', continentForce());
  Graph.onEngineStop(function(){ if (Graph.zoomToFit) Graph.zoomToFit(600, 50); });

  window.addEventListener('resize', function(){Graph.width(elem.clientWidth).height(elem.clientHeight);});
  Graph.width(elem.clientWidth).height(elem.clientHeight);
}

function showDetail(d){
  const det = document.getElementById('detail');
  det.classList.remove('placeholder');
  const chain = (DATA.chainsByNode && DATA.chainsByNode[d.node_id]) || [];
  const layers = chain.length
    ? chain.map(function(l){
        return '<div class="layer'+(l.isHead?' head':'')+'">'+
          '<span class="tag">'+(l.isHead?'HEAD':'layer')+'</span>'+
          '<div class="txt">'+esc(l.text)+'</div>'+
          '<div class="ts">'+esc(l.createdAt||'')+'</div></div>';
      }).join('')
    : '<div class="placeholder">No notes for this feature.</div>';
  det.innerHTML =
    '<div class="ctry-name" style="color:'+colorFor(d.continent)+'">'+esc(d.country||d.node_id)+'</div>'+
    '<div class="ctry-cont">'+esc(d.continent)+' · '+esc(d.node_id)+'</div>'+
    '<div class="ctry-stats">'+
      '<div class="s"><div class="v">'+(d.editCount||0)+'</div><div class="l">Edits</div></div>'+
      '<div class="s"><div class="v">'+(d.memberCount||0)+'</div><div class="l">Members</div></div>'+
      '<div class="s"><div class="v">'+(d.noteCount||0)+'</div><div class="l">Notes</div></div>'+
    '</div>'+
    '<div class="hist-header">Layered note chain ('+chain.length+')</div>'+layers+neighborHtml(d);
}

// Semantic neighbors of the clicked country (from the edge list), strongest first,
// as clickable buttons — click one to jump the detail panel to that feature.
function neighborHtml(d){
  var nbrs = [];
  (DATA.edges||[]).forEach(function(e){
    if (e.source === d.node_id) nbrs.push({ id: e.target, w: e.weight });
    else if (e.target === d.node_id) nbrs.push({ id: e.source, w: e.weight });
  });
  if (!nbrs.length) return '';
  nbrs.sort(function(a,b){return b.w-a.w;});
  return '<div class="nbr-header">Neighbors ('+nbrs.length+')</div>'+
    nbrs.map(function(n){return '<button class="nbr" data-id="'+esc(n.id)+'">'+esc(n.id)+'<span class="w">'+(Number(n.w)||0).toFixed(2)+'</span></button>';}).join('');
}

// Wire the search box, clickable continent legend (show/hide), and neighbor buttons.
(function wireControls(){
  var s = document.getElementById('search');
  if (s){
    s.addEventListener('input', function(){ searchTerm = s.value.trim().toLowerCase(); applyFilter(); });
    s.addEventListener('keydown', function(e){ if (e.key === 'Enter' && Graph && Graph.zoomToFit) Graph.zoomToFit(600, 60, nodeMatches); });
  }
  var lr = document.getElementById('legend-rows');
  if (lr) lr.addEventListener('click', function(e){
    var row = e.target.closest ? e.target.closest('.legend-row') : null;
    if (!row) return;
    var c = row.getAttribute('data-cont'); if (!c) return;
    hiddenContinents[c] = !hiddenContinents[c];
    renderLegend(); applyFilter();
  });
  var det = document.getElementById('detail');
  if (det) det.addEventListener('click', function(e){
    var btn = e.target.closest ? e.target.closest('.nbr') : null;
    if (!btn) return;
    var raw = DATA.nodes.filter(function(n){return n.node_id === btn.getAttribute('data-id');})[0];
    if (raw) showDetail(Object.assign({ id: raw.node_id }, raw));
  });
})();
</script>
</body>
</html>`;

  const dir = path.dirname(out);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(out, html);
  return html;
}

module.exports = { buildFeatureNodes, buildNeighborEdges, buildNoteChain, renderHtml, safeJsonForScript };

// --- CLI entry (guarded so require() in tests does not open the DB or write files) ---
if (require.main === module) {
  const DB = process.argv[2] || process.env.DEVGUARD_DB || DEFAULT_DB;
  const OUT = process.argv[3] || process.env.DEVGUARD_SPHEREMAP_OUT || DEFAULT_OUT;
  const PROJECT_PATH = process.argv[4] || process.env.DEVGUARD_PROJECT_ROOT || REPO_ROOT;
  const PROJECT_NAME = process.argv[5] || process.env.DEVGUARD_PROJECT_NAME || 'devguard';

  process.env.CLAUDE_PLUGIN_DATA = process.env.CLAUDE_PLUGIN_DATA || path.dirname(DB);
  const { getDb } = require('../src/engine/db');
  const db = getDb(PROJECT_PATH);

  const nodes = buildFeatureNodes(db);
  const rows = db.getAllFeatures().map((f) => ({ node_id: f.node_id, centroid_embedding: f.centroid_embedding }));
  const edges = buildNeighborEdges(rows, EDGE_THRESHOLD, EDGE_TOP_N);
  const chainsByNode = {};
  for (const n of nodes) chainsByNode[n.node_id] = buildNoteChain(db, n.node_id);

  renderHtml({ nodes, edges, chainsByNode, project: PROJECT_NAME }, OUT);
  console.log('wrote', OUT, '—', nodes.length, 'features,', edges.length, 'edges');
}
