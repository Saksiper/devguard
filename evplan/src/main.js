// Uygulama girişi: verileri yükle, doğrula, görüntüleyici + paneli kur, kontrolleri çalıştır.

import { buildPlanModel } from './core/plan.js';
import { validateCatalog, validateLayout, validatePlan } from './core/validate.js';
import { runChecks } from './core/checks.js';
import { normAngle } from './core/geom.js';
import { Store, decodeShare } from './store.js';
import { Viewer } from './view/viewer.js';
import { Panel } from './ui/panel.js';

// Veri seti: ?veri=demo ile örnek daire; varsayılan olarak data/ev/ varsa o, yoksa demo.
// window.__EVPLAN_DATA__ verilmişse (tek dosyalık sürüm) veri dosyaları okunmaz.
const SETS = ['ev', 'demo'];
async function pickDataSet() {
  const want = new URLSearchParams(location.search).get('veri');
  const order = want ? [want, ...SETS.filter((s) => s !== want)] : SETS;
  for (const s of order) {
    try {
      const res = await fetch(`./data/${s}/plan.json`, { cache: 'no-cache' });
      if (res.ok) return s;
    } catch {
      /* sıradakini dene */
    }
  }
  return 'demo';
}

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
  let embeddedLayouts = null;
  const EMBED = window.__EVPLAN_DATA__;
  if (EMBED) {
    ({ plan, catalog } = EMBED);
    embeddedLayouts = EMBED.layouts ?? [];
    index = { layouts: [] };
  } else {
    const set = await pickDataSet();
    const DATA = `./data/${set}/`;
    try {
      [plan, catalog, index] = await Promise.all([
        getJSON(`${DATA}plan.json`),
        getJSON(`${DATA}furniture.json`).catch(() => getJSON('./data/furniture.json')),
        getJSON(`${DATA}layouts/index.json`).catch(() => ({ layouts: [] })),
      ]);
    } catch (e) {
      return fatal('Veri yüklenemedi', [e.message, `Veri seti: data/${set}/`]);
    }
    index.base = DATA;
  }
  const vp = validatePlan(plan);
  const vc = validateCatalog(catalog);
  if (vp.errors.length || vc.errors.length) return fatal('Veri dosyalarında hata var', [...vp.errors, ...vc.errors]);

  const fileLayouts = [];
  const layoutProblems = [];
  const layoutSources = embeddedLayouts ?? (index.layouts ?? []).map((f) => ({ file: f }));
  for (const src of layoutSources) {
    const f = src.file ?? `${src.id}.json`;
    try {
      const l = src.file ? await getJSON(`${index.base}layouts/${f}`) : structuredClone(src);
      l.id = l.id ?? f.replace(/\.json$/, '');
      const v = validateLayout(l, catalog);
      if (v.errors.length) layoutProblems.push(...v.errors);
      else fileLayouts.push(l);
    } catch (e) {
      layoutProblems.push(e.message);
    }
  }

  const model = buildPlanModel(plan);
  if (!fileLayouts.length) fileLayouts.push({ id: 'bos', name: 'Boş ev', items: [] });
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
  const panel = new Panel({ store, viewer, model, fileLayouts, toast, compare, embedded: !!EMBED });
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
      if (panel.tab === 'add') panel.renderAdd();
      if (store.selection && !panel.keepTab && !panel.isMobile()) panel.showTab('selected');
      panel.keepTab = false;
      return;
    }
    panel.renderSelect();
    panel.renderSelected();
    if (panel.tab === 'add') panel.renderAdd();
    if (panel.tab === 'layouts' || t === 'layout') panel.renderLayouts();
    full();
  });

  // Mod düğmeleri ve görünüm araçları.
  const modeBtns = document.querySelectorAll('.modes button');
  const setMode = (m) => {
    if (viewer.photo) viewer.stopPhoto();
    viewer.setMode(m);
    document.getElementById('stage').dataset.mode = m;
    for (const b of modeBtns) b.classList.toggle('active', b.dataset.mode === m);
    document.getElementById('walk-help').hidden = m !== 'walk';
    document.getElementById('btn-cut').hidden = m !== 'orbit';
    document.getElementById('btn-tape').hidden = m === 'walk';
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
  let hq = true;
  try {
    const v = localStorage.getItem('evplan:hq');
    if (v !== null) hq = v === '1';
  } catch {
    /* depolama yok */
  }
  viewer.setQuality(hq);
  const hqBtn = document.getElementById('btn-hq');
  hqBtn.classList.toggle('active', hq);
  hqBtn.addEventListener('click', () => {
    hq = !hq;
    viewer.setQuality(hq);
    hqBtn.classList.toggle('active', hq);
    try {
      localStorage.setItem('evplan:hq', hq ? '1' : '0');
    } catch {
      /* depolama yok */
    }
  });
  // Güneş: saat ve tarih (evin konumuna göre). Ayar tarayıcıda hatırlanır.
  const sunBtn = document.getElementById('btn-sun');
  const sunPop = document.getElementById('sun-pop');
  const sunHour = document.getElementById('sun-hour');
  const sunDate = document.getElementById('sun-date');
  const WIND = ['kuzeyde', 'kuzeydoğuda', 'doğuda', 'güneydoğuda', 'güneyde', 'güneybatıda', 'batıda', 'kuzeybatıda'];
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  let sunState = { date: today(), hour: 14 };
  try {
    sunState = { ...sunState, ...JSON.parse(localStorage.getItem('evplan:sun') ?? '{}') };
  } catch {
    /* depolama yok */
  }
  const applySun = () => {
    const [y, m, d] = sunState.date.split('-').map(Number);
    const pos = viewer.setSunTime({ y, m, d, hour: sunState.hour });
    sunHour.value = sunState.hour;
    sunDate.value = sunState.date;
    const h = Math.floor(sunState.hour);
    document.getElementById('sun-clock').textContent = `${pad(h)}:${pad(Math.round((sunState.hour - h) * 60))}`;
    const info = document.getElementById('sun-info');
    if (!pos) return (info.textContent = '');
    const site = model.plan.site;
    const where = site ? `${site.city ?? 'Ev'}${site.assumed ? ' (yön varsayım)' : ''}` : 'Konum yok: İstanbul ve plan sağı = kuzey varsayıldı';
    if (pos.elevation < -0.5) info.textContent = `${where}: güneş batmış; sarkıt lambalar yanıyor.`;
    else {
      const lit = viewer.daylight?.sunlitRooms() ?? [];
      info.textContent = `${where}: güneş ${Math.round(pos.elevation)}° yükseklikte, ${WIND[Math.round(pos.azimuth / 45) % 8]}. ${lit.length ? `Şu an güneş alan: ${lit.join(', ')}.` : 'Şu an hiçbir cama doğrudan güneş vurmuyor.'}`;
    }
    try {
      localStorage.setItem('evplan:sun', JSON.stringify(sunState));
    } catch {
      /* depolama yok */
    }
  };
  const syncSunBtn = () => {
    sunBtn.hidden = !hq || viewer.mode === 'plan';
    if (sunBtn.hidden) sunPop.hidden = true;
    sunBtn.classList.toggle('active', !sunPop.hidden);
  };
  sunBtn.addEventListener('click', () => {
    sunPop.hidden = !sunPop.hidden;
    syncSunBtn();
    applySun();
  });
  sunHour.addEventListener('input', () => {
    sunState.hour = Number(sunHour.value);
    applySun();
  });
  sunDate.addEventListener('change', () => {
    if (sunDate.value) sunState.date = sunDate.value;
    applySun();
  });
  for (const b of sunPop.querySelectorAll('[data-season]')) {
    b.addEventListener('click', () => {
      const y = new Date().getFullYear();
      sunState.date = { today: today(), summer: `${y}-06-21`, winter: `${y}-12-21` }[b.dataset.season];
      applySun();
    });
  }
  viewer.addEventListener('mode', syncSunBtn);
  viewer.addEventListener('lighting', applySun);
  hqBtn.addEventListener('click', () => {
    syncSunBtn();
    applySun();
  });
  syncSunBtn();
  applySun();
  // Foto modu: ışın izleme. Kamera durur; bekledikçe netleşir.
  const photoBtn = document.getElementById('btn-photo');
  const photoHud = document.getElementById('photo-hud');
  const photoStatus = document.getElementById('photo-status');
  const syncPhotoBtn = () => {
    photoBtn.hidden = viewer.mode === 'plan';
  };
  photoBtn.addEventListener('click', () => {
    if (viewer.photo) return viewer.stopPhoto();
    store.select(null);
    photoStatus.textContent = 'Foto hazırlanıyor…';
    photoHud.hidden = false;
    viewer.startPhoto().catch((e) => {
      photoHud.hidden = true;
      toast(`Foto modu açılamadı: ${e?.message ?? e}`);
    });
  });
  viewer.addEventListener('photo', (e) => {
    const { on, samples, done } = e.detail;
    photoHud.hidden = !on;
    photoBtn.classList.toggle('active', on);
    for (const id of ['walk-help', 'hud-tl']) document.getElementById(id).style.visibility = on ? 'hidden' : '';
    if (on)
      photoStatus.textContent = done
        ? `Foto hazır (${samples} örnek).`
        : samples
          ? `Işın izleme: ${samples} örnek · bekledikçe netleşir`
          : 'Foto hazırlanıyor…';
  });
  document.getElementById('photo-close').addEventListener('click', () => viewer.stopPhoto());
  const embedded = !!window.__EVPLAN_DATA__;
  document.getElementById('photo-save').hidden = embedded; // gömülü önizlemede indirme izni yok
  document.getElementById('photo-save').addEventListener('click', () =>
    viewer.photoSnapshot((url) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = `${model.meta.name ?? 'ev'}-foto.png`;
      a.click();
    }),
  );
  viewer.addEventListener('mode', syncPhotoBtn);
  syncPhotoBtn();
  document.getElementById('btn-tape').addEventListener('click', (e) => {
    const on = !viewer.tapeOn;
    viewer.setTape(on);
    e.currentTarget.classList.toggle('active', on);
    if (on) toast('Mezura: ölçmek istediğin iki noktaya dokun. Planda yatay mesafe, 3D\'de gerçek mesafe.');
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
    if (k === 'Escape' && viewer.photo) return viewer.stopPhoto();
    const it = store.selection ? store.item(store.selection) : null;
    if (!it) return;
    // Silme ve seçimi bırakma her modda (yürürken de) çalışır.
    if (k === 'Delete' || k === 'Backspace') {
      e.preventDefault();
      const name = it.name;
      store.remove(it.uid);
      return toast(`${name} silindi. Geri almak için Ctrl+Z.`);
    }
    if (k === 'Escape') return store.select(null);
    if (k === 'h' || k === 'H') {
      store.setHidden(it.uid, true);
      return toast(`${it.name} gizlendi.`);
    }
    if (viewer.mode === 'walk') return; // oklar/QE yürümeye ait
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
  });

  setMode('plan');
  viewer.refresh();
  panel.renderSelected();
  full();
  window.__evplan = { store, viewer, model, panel, get last() { return lastFull; } };
}

boot().catch((e) => fatal('Beklenmeyen hata', [String(e?.stack ?? e)]));
