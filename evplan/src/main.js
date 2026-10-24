// Uygulama girişi: verileri yükle, doğrula, görüntüleyici + paneli kur, kontrolleri çalıştır.

import { buildPlanModel } from './core/plan.js';
import { validateCatalog, validateLayout, validatePlan } from './core/validate.js';
import { runChecks } from './core/checks.js';
import { normAngle } from './core/geom.js';
import { Store, decodeShare } from './store.js';
import { Viewer } from './view/viewer.js';
import { Panel } from './ui/panel.js';

const DATA = './data/';

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path} okunamadı (HTTP ${res.status}).`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} geçerli JSON değil: ${e.message}`);
  }
}

function fatal(title, lines) {
  const el = document.getElementById('fatal');
  el.hidden = false;
  el.innerHTML = `<h2>${title}</h2><pre></pre><p>Veri dosyaları: <code>public/data/</code>. Düzeltip sayfayı yenileyin.</p>`;
  el.querySelector('pre').textContent = lines.join('\n');
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/** Ağır kontrolleri web worker'da çalıştırır; worker yoksa ana iş parçacığında. */
class Checker {
  constructor(plan, model) {
    this.plan = plan;
    this.model = model;
    this.pending = new Map();
    this.seq = 0;
    try {
      this.worker = new Worker(new URL('./checks.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve({ ...e.data.result, itemState: new Map(e.data.result.itemState) });
      };
      this.worker.onerror = () => {
        // Worker açılamadıysa bekleyen işleri ana iş parçacığında bitir.
        this.worker = null;
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.resolve(runChecks(this.model, p.items));
        }
      };
    } catch {
      this.worker = null;
    }
  }

  run(items) {
    const id = ++this.seq;
    if (!this.worker) return new Promise((resolve) => setTimeout(() => resolve(runChecks(this.model, items)), 0));
    const plain = JSON.parse(JSON.stringify(items));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, items: plain });
      this.worker.postMessage({ id, plan: this.plan, items: plain });
    });
  }
}

async function boot() {
  let plan;
  let catalog;
  let index;
  try {
    [plan, catalog, index] = await Promise.all([
      getJSON(`${DATA}plan.json`),
      getJSON(`${DATA}furniture.json`),
      getJSON(`${DATA}layouts/index.json`).catch(() => ({ layouts: [] })),
    ]);
  } catch (e) {
    return fatal('Veri yüklenemedi', [e.message]);
  }
  const vp = validatePlan(plan);
  const vc = validateCatalog(catalog);
  if (vp.errors.length || vc.errors.length) return fatal('Veri dosyalarında hata var', [...vp.errors, ...vc.errors]);

  const fileLayouts = [];
  const layoutProblems = [];
  for (const f of index.layouts ?? []) {
    try {
      const l = await getJSON(`${DATA}layouts/${f}`);
      l.id = l.id ?? f.replace(/\.json$/, '');
      const v = validateLayout(l, catalog);
      if (v.errors.length) layoutProblems.push(...v.errors);
      else fileLayouts.push(l);
    } catch (e) {
      layoutProblems.push(e.message);
    }
  }

  const model = buildPlanModel(plan);
  const store = new Store({ plan, catalog, fileLayouts });

  if (location.hash.startsWith('#y=')) {
    try {
      const shared = await decodeShare(location.hash.slice(3));
      store.importLayout(shared, ' (paylaşılan)');
      toast('Paylaşılan yerleşim yüklendi.');
    } catch {
      toast('Paylaşım linki okunamadı.');
    }
    history.replaceState(null, '', location.pathname + location.search);
  }

  document.getElementById('plan-name').textContent = plan.meta?.name ?? 'Ev planı';
  document.getElementById('demo-badge').hidden = !plan.meta?.demo;
  document.title = `${plan.meta?.name ?? 'Ev'} · Yerleşim`;

  const viewer = new Viewer(document.getElementById('viewport'), store, model);
  const checker = new Checker(plan, model);

  const compare = async () => {
    const rows = [];
    for (const l of store.list()) {
      const r = await checker.run(store.resolveLayout(l));
      rows.push({ id: l.id, name: l.name, m: r.metrics });
    }
    return rows;
  };
  const panel = new Panel({ store, viewer, model, fileLayouts, toast, compare });
  if (vp.warnings.length || layoutProblems.length) toast([...vp.warnings, ...layoutProblems].slice(0, 3).join(' · '), 8000);

  // Kontroller: sürüklerken hızlı (geçiş analizi hariç), bırakınca tam (worker'da).
  let lastFull = null;
  let latest = 0;
  const full = async () => {
    const id = ++latest;
    const r = await checker.run(store.items());
    if (id !== latest) return;
    lastFull = r;
    viewer.setChecks(r);
    panel.setResult(r);
  };
  let quickQueued = false;
  const quick = () => {
    if (quickQueued) return;
    quickQueued = true;
    requestAnimationFrame(() => {
      quickQueued = false;
      const r = runChecks(model, store.items(), { passage: false });
      // Geçiş sonuçları bırakınca yenilenir; o ana dek eski yol çizimi gizlenir.
      viewer.setChecks({ ...r, passage: null });
      panel.setResult(r);
    });
  };

  store.addEventListener('change', (e) => {
    const t = e.detail.type;
    if (t === 'live') {
      viewer.refresh();
      panel.renderSelbar();
      quick();
      return;
    }
    viewer.refresh();
    if (t === 'select') {
      panel.renderSelected();
      if (store.selection && !panel.keepTab && !panel.isMobile()) panel.showTab('selected');
      panel.keepTab = false;
      return;
    }
    panel.renderSelect();
    panel.renderSelected();
    if (panel.tab === 'layouts' || t === 'layout') panel.renderLayouts();
    full();
  });

  // Mod düğmeleri ve görünüm araçları.
  const modeBtns = document.querySelectorAll('.modes button');
  const setMode = (m) => {
    viewer.setMode(m);
    for (const b of modeBtns) b.classList.toggle('active', b.dataset.mode === m);
    document.getElementById('walk-help').hidden = m !== 'walk';
    document.getElementById('btn-cut').hidden = m !== 'orbit';
    // Telefonda yürürken panel kapansın, ekran yürümeye kalsın.
    if (m === 'walk' && panel.isMobile()) document.getElementById('panel').classList.add('collapsed');
    viewer.refresh();
    panel.renderSelbar();
  };
  for (const b of modeBtns) b.addEventListener('click', () => setMode(b.dataset.mode));
  document.getElementById('btn-fit').addEventListener('click', () => viewer.fit());
  document.getElementById('btn-cut').addEventListener('click', (e) => e.currentTarget.classList.toggle('active', viewer.toggleCut()));
  document.getElementById('btn-cut').classList.add('active');
  document.getElementById('btn-zones').addEventListener('click', (e) => {
    viewer.furniture.showZones = !viewer.furniture.showZones;
    e.currentTarget.classList.toggle('active', viewer.furniture.showZones);
    viewer.refresh();
  });
  document.getElementById('btn-paths').addEventListener('click', (e) => {
    viewer.showPaths = !viewer.showPaths;
    e.currentTarget.classList.toggle('active', viewer.showPaths);
    viewer.refresh();
  });
  document.getElementById('btn-labels').addEventListener('click', (e) => {
    const on = !viewer.labelsOn;
    viewer.labelsOn = on;
    viewer.furniture.labels.visible = on && viewer.mode === 'plan';
    e.currentTarget.classList.toggle('active', on);
  });
  // Sorun listesinden seçince sekme değişmesin.
  document.getElementById('tab-checks').addEventListener('click', () => (panel.keepTab = true), { capture: true });

  // Klavye kısayolları.
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input,select,textarea')) return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    if (k === '1' || k === '2' || k === '3') return setMode(['plan', 'orbit', 'walk'][Number(k) - 1]);
    if (ctrl && k.toLowerCase() === 'z') {
      e.preventDefault();
      return e.shiftKey ? store.redo() : store.undo();
    }
    if (ctrl && k.toLowerCase() === 'y') {
      e.preventDefault();
      return store.redo();
    }
    if (viewer.mode === 'walk') return;
    const it = store.selection ? store.item(store.selection) : null;
    if (!it) return;
    const step = e.shiftKey ? 10 : 1;
    const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[k];
    if (nudge) {
      e.preventDefault();
      return store.update(it.uid, { x: it.x + nudge[0], y: it.y + nudge[1] });
    }
    if (ctrl && k.toLowerCase() === 'd') {
      e.preventDefault();
      return store.duplicate(it.uid);
    }
    const rot = { r: e.shiftKey ? -90 : 90, R: -90, q: -15, Q: -15, e: 15, E: 15 }[k];
    if (rot && !ctrl) return store.update(it.uid, { rot: normAngle(it.rot + rot) });
    if (k === 'Delete' || k === 'Backspace') return store.remove(it.uid);
    if (k === 'Escape') return store.select(null);
  });

  setMode('plan');
  viewer.refresh();
  panel.renderSelected();
  full();
  window.__evplan = { store, viewer, model, panel, get last() { return lastFull; } };
}

boot().catch((e) => fatal('Beklenmeyen hata', [String(e?.stack ?? e)]));
