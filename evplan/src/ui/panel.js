// Yan panel: kontrol listesi, seçili mobilya düzenleyici, katalog, yerleşim yönetimi ve karşılaştırma.

import { normAngle } from '../core/geom.js';
import { encodeShare } from '../store.js';
import { requestThumb } from '../view/thumbs.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SEV = { error: '!', warn: '!', info: 'i' };

/** Marka adı ürün adında zaten geçiyorsa ("Samsung 55\" …") başa tekrar yazılmaz. */
const brandPrefix = (c) =>
  c.brand && !c.name.toLocaleLowerCase('tr').startsWith(c.brand.toLocaleLowerCase('tr')) ? `${c.brand} ` : '';

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export class Panel {
  constructor({ store, viewer, model, fileLayouts, toast, compare, embedded = false }) {
    this.embedded = embedded;
    this.store = store;
    this.viewer = viewer;
    this.model = model;
    this.fileLayouts = fileLayouts;
    this.toast = toast;
    this.compare = compare;
    this.result = null;
    this.cmpRows = null;
    this.el = {
      panel: document.getElementById('panel'),
      checks: document.getElementById('tab-checks'),
      selected: document.getElementById('tab-selected'),
      add: document.getElementById('tab-add'),
      layouts: document.getElementById('tab-layouts'),
      count: document.getElementById('tab-checks-count'),
      select: document.getElementById('layout-select'),
      pill: document.getElementById('status-pill'),
    };
    for (const b of document.querySelectorAll('.tabs button'))
      b.addEventListener('click', () => {
        // Telefonda: açık sekmeye tekrar dokununca levha kapanır.
        if (this.isMobile() && this.tab === b.dataset.tab && !this.el.panel.classList.contains('collapsed'))
          this.el.panel.classList.add('collapsed');
        else this.showTab(b.dataset.tab);
      });
    if (this.isMobile()) this.el.panel.classList.add('collapsed');
    this.tab = 'checks';
    this.initSelbar();
    document.getElementById('hidden-pill').addEventListener('click', () => {
      const list = this.store.hiddenEntries();
      this.store.setHidden(list.map((i) => i.uid), false);
    });
    document.getElementById('btn-tv').addEventListener('click', () => {
      const hidden = this.store.toggleGroupHidden('Televizyon');
      if (hidden !== null) this.toast(hidden ? 'Televizyonlar gizlendi.' : 'Televizyonlar gösteriliyor.');
    });
    document.getElementById('panel-grip').addEventListener('click', () => this.el.panel.classList.toggle('collapsed'));
    this.el.select.addEventListener('change', () => store.setActive(this.el.select.value));
    this.renderAdd();
    this.renderLayouts();
    this.renderSelect();
    this.renderChecks();
  }

  thumb(c, choice, cb) {
    requestThumb(c, choice, cb, this.store.catalogById);
  }

  isMobile() {
    return window.matchMedia('(max-width: 760px)').matches;
  }

  initSelbar() {
    const bar = document.getElementById('selbar');
    this.el.selbar = bar;
    const act = {
      'r-90': () => this.rotate(-90),
      'r-15': () => this.rotate(-15),
      r15: () => this.rotate(15),
      r90: () => this.rotate(90),
      more: () => this.showTab('selected'),
      close: () => this.store.select(null),
      hide: () => {
        const it = this.store.selection ? this.store.item(this.store.selection) : null;
        if (!it) return;
        this.store.setHidden(it.uid, true);
        this.toast(`${it.name} gizlendi. Sol üstteki "gizli" etiketinden geri gösterebilirsin.`);
      },
      del: () => {
        const it = this.store.selection ? this.store.item(this.store.selection) : null;
        if (!it) return;
        this.store.remove(it.uid);
        this.toast(`${it.name} silindi. Geri almak için ↶ (Yerleşimler) ya da Ctrl+Z.`);
      },
      prev: () => this.cycle(-1),
      next: () => this.cycle(1),
      here: () => {
        const it = this.store.selection ? this.store.item(this.store.selection) : null;
        if (!it) return;
        const p = this.viewer.placementFor(it);
        this.store.update(it.uid, { x: p.x, y: p.y, rot: p.rot });
      },
    };
    for (const b of bar.querySelectorAll('button')) b.addEventListener('click', () => act[b.dataset.s]());
  }

  renderHidden() {
    const pill = document.getElementById('hidden-pill');
    const list = this.store.hiddenEntries();
    pill.hidden = !list.length;
    pill.textContent = list.length ? `${list.length} gizli · göster` : '';
    pill.title = list.map((i) => i.name).join(', ');
    const tvBtn = document.getElementById('btn-tv');
    const tvs = this.store.active.items.filter((e) => this.store.catalogById.get(e.ref)?.group === 'Televizyon');
    tvBtn.hidden = !tvs.length;
    tvBtn.classList.toggle('active', tvs.some((e) => !e.hidden));
  }

  renderSelbar() {
    this.renderHidden();
    const it = this.store.selection ? this.store.item(this.store.selection) : null;
    const bar = this.el.selbar;
    bar.hidden = !it;
    if (!it) return;
    bar.querySelector('[data-s="here"]').hidden = this.viewer.mode !== 'walk';
    const alts = this.store.catalog.items.filter((c) => (it.group ? c.group === it.group : c.category === it.category)).length;
    for (const b of bar.querySelectorAll('[data-s="prev"],[data-s="next"]')) b.hidden = alts < 2;
    const st = this.result?.itemState?.get(it.uid);
    const name = bar.querySelector('.name');
    name.textContent = `${it.name} · ${Math.round(it.rot)}°`;
    name.className = `name ${st ?? ''}`;
  }

  showTab(name) {
    this.el.panel.classList.remove('collapsed');
    for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === `tab-${name}`);
    this.tab = name;
    if (name === 'layouts') this.renderLayouts();
    if (name === 'add') this.renderAdd();
  }

  renderSelect() {
    this.el.select.innerHTML = this.store
      .list()
      .map((l) => `<option value="${esc(l.id)}" ${l.id === this.store.activeId ? 'selected' : ''}>${esc(l.name)}${l.modified ? ' •' : ''}</option>`)
      .join('');
  }

  setResult(result) {
    this.result = result;
    this.renderChecks();
    this.renderSelbar();
    const { errors, warnings } = result.metrics;
    const pill = this.el.pill;
    pill.className = `pill ${errors ? 'err' : warnings ? 'warn' : 'ok'}`;
    pill.textContent = errors ? `${errors} sorun` : warnings ? `${warnings} uyarı` : 'Sığıyor ✓';
    this.el.count.textContent = errors + warnings ? `(${errors + warnings})` : '';
  }

  renderChecks() {
    const r = this.result;
    if (!r) {
      this.el.checks.innerHTML = '<p class="note">Hesaplanıyor…</p>';
      return;
    }
    const m = r.metrics;
    const meta = this.model.meta;
    const S = this.model.settings;
    let html = '';
    if (meta.demo)
      html += `<details class="note warnbox demo"><summary>DEMO plan: tüm ölçüler varsayım</summary>${esc(meta.note ?? '')}</details>`;
    html += `<div class="summary">
      <div><b class="${m.errors ? 'e' : 'g'}">${m.errors}</b>sorun</div>
      <div><b class="${m.warnings ? 'w' : 'g'}">${m.warnings}</b>uyarı</div>
      <div><b>${m.minPassage === null ? '–' : Math.round(m.minPassage)}</b>en dar kapı yolu (cm)</div>
    </div>`;
    if (!r.issues.length) html += `<p class="note">Çakışma yok, kapılar ve kapaklar açılıyor, geçişler en az ${S.passageMin} cm.</p>`;
    html += '<ol class="issues">';
    r.issues.forEach((is, i) => {
      html += `<li class="${is.severity}" data-i="${i}"><span class="dot">${is.severity === 'info' ? SEV.info : i + 1}</span><span>${esc(is.text)}</span></li>`;
    });
    html += '</ol>';
    html += `<p class="note">Ölçütler: geçiş hedefi ${S.passageMin} cm (altı turuncu, ${S.passageHard} cm altı kırmızı), mobilya önüne erişim ${S.accessMin} cm, ızgara ±${S.gridStep} cm. Değerler <code>plan.json → settings</code> içinden değiştirilebilir.</p>`;
    const todo = [...(meta.missing ?? []).map((x) => `Eksik: ${x}`), ...(meta.thinWalls ?? []), ...(meta.notes ?? [])];
    if (todo.length || (!meta.demo && meta.note))
      html += `<details class="note warnbox"><summary>Eksik / teyit edilecek (${todo.length})</summary>${meta.note ? `<p>${esc(meta.note)}</p>` : ''}<ul>${todo
        .map((t) => `<li>${esc(t)}</li>`)
        .join('')}</ul></details>`;
    if (m.roomFree) {
      html += '<h3>Odalarda boş zemin</h3><table class="cmp"><tr><th>Oda</th><th>Boş</th></tr>';
      for (const rf of m.roomFree) {
        if (!rf.cells) continue;
        html += `<tr><td>${esc(rf.name)}</td><td>%${Math.round((100 * rf.freeCells) / rf.cells)}</td></tr>`;
      }
      html += '</table>';
    }
    this.el.checks.innerHTML = html;
    for (const li of this.el.checks.querySelectorAll('.issues li')) {
      li.addEventListener('click', () => {
        const is = r.issues[Number(li.dataset.i)];
        const uid = is.items.find((u) => u && this.store.item(u));
        if (uid) this.store.select(uid);
        this.viewer.focus(is.at);
      });
    }
  }

  renderSelected() {
    this.renderSelbar();
    const it = this.store.selection ? this.store.item(this.store.selection) : null;
    const el = this.el.selected;
    if (!it) {
      el.innerHTML = `<p class="note">Planda bir mobilyaya dokunun. Sürükleyerek taşıyın; iki parmakla çevirerek ya da aşağıdaki düğmelerle döndürün. Yürürken de mobilyaya dokunarak seçebilirsiniz.</p>
        <p class="note">Klavye: oklar 1 cm (Shift 10 cm) · R / Shift+R 90° · Q / E 15° · H gizle · Del sil · Ctrl+D çoğalt · Ctrl+Z geri al · Alt basılı sürükle = mıknatıssız</p>`;
      return;
    }
    const issues = (this.result?.issues ?? []).filter((i) => i.items.includes(it.uid));
    const product = this.productBlock(it);
    el.innerHTML = `
      <h3>${esc(brandPrefix(it))}${esc(it.name)}${it.assumed ? ' <span class="badge warn">örnek ölçü</span>' : it.sample ? ' <span class="badge warn">örnek</span>' : ''}</h3>
      ${product}
      <div class="row">
        <button data-a="r-90" title="Shift+R">⟲ 90°</button>
        <button data-a="r-15" title="Q">⟲ 15°</button>
        <button data-a="r15" title="E">⟳ 15°</button>
        <button data-a="r90" title="R">⟳ 90°</button>
      </div>
      <div class="form">
        <label>Konum x (cm)<input type="number" step="1" data-k="x" value="${Math.round(it.x * 10) / 10}"></label>
        <label>Konum y (cm)<input type="number" step="1" data-k="y" value="${Math.round(it.y * 10) / 10}"></label>
        <label>Açı (°)<input type="number" step="5" data-k="rot" value="${Math.round(it.rot * 10) / 10}"></label>
        <label>Genişlik G<input type="number" step="1" data-k="w" value="${it.w}"></label>
        <label>Derinlik D<input type="number" step="1" data-k="d" value="${it.d}"></label>
        <label>Yükseklik Y<input type="number" step="1" data-k="h" value="${it.h}"></label>
        <label>Yerden (cm)<input type="number" step="1" data-k="z" value="${it.z}"></label>
        ${it.options ? '' : `<label>Renk<input type="color" data-k="color" value="${esc(it.color)}"></label>`}
        <label>Ad<input type="text" data-k="name" value="${esc(it.name)}"></label>
      </div>
      <div class="row">
        <button data-a="dup">Çoğalt</button>
        <button data-a="reset" title="Bu yerleşimde değiştirilen ölçü/renk/adı katalogdakine döndür">Kataloğa dön</button>
        <button data-a="del" class="danger">Sil</button>
      </div>
      ${issues.length ? `<h3>Bu mobilyanın sorunları</h3><ol class="issues">${issues.map((is) => `<li class="${is.severity}"><span class="dot">${SEV[is.severity]}</span><span>${esc(is.text)}</span></li>`).join('')}</ol>` : ''}
      <h3>Yerine dene${it.group ? ` · ${esc(it.group)}` : ''}</h3>
      <div class="alts" id="alts"></div>
      <p class="kv">Ölçüyü burada değiştirmek yalnızca bu yerleşimi etkiler. Kalıcı ürün ölçüsü için <code>furniture.json</code> düzenlenir.</p>
    `;
    for (const inp of el.querySelectorAll('input[data-k]')) {
      inp.addEventListener('change', () => {
        const k = inp.dataset.k;
        let v = inp.type === 'number' ? Number(inp.value) : inp.value;
        if (inp.type === 'number' && !Number.isFinite(v)) return;
        if (k === 'rot') v = normAngle(v);
        if (['w', 'd', 'h'].includes(k) && v <= 0) return;
        this.store.update(it.uid, { [k]: v });
      });
    }
    for (const sel of el.querySelectorAll('select[data-opt]'))
      sel.addEventListener('change', () => this.store.update(it.uid, { choice: { ...(it.choice ?? {}), [sel.dataset.opt]: sel.value } }));
    for (const b of el.querySelectorAll('button[data-sw]'))
      b.addEventListener('click', () => this.store.update(it.uid, { choice: { ...(it.choice ?? {}), [b.dataset.opt]: b.dataset.sw } }));
    const act = {
      'r-90': () => this.rotate(-90),
      'r-15': () => this.rotate(-15),
      r15: () => this.rotate(15),
      r90: () => this.rotate(90),
      dup: () => this.store.duplicate(it.uid),
      del: () => this.store.remove(it.uid),
      reset: () => this.store.update(it.uid, { w: null, d: null, h: null, z: null, color: null, name: null }),
    };
    for (const b of el.querySelectorAll('button[data-a]')) b.addEventListener('click', () => act[b.dataset.a]());
    this.renderAlts(it, el.querySelector('#alts'));
  }

  /** Gerçek ürün bilgisi: seçenekler (renk örnekleri), fiyat, link, malzeme, ek ölçüler. */
  productBlock(it) {
    const parts = [];
    for (const opt of it.options ?? []) {
      const cur = it.choice?.[opt.name];
      const swatches = opt.values.some((v) => v.color);
      parts.push(`<div class="opt"><span class="opt-name">${esc(opt.name)}: <b>${esc(cur)}</b></span>${
        swatches
          ? `<div class="swatches">${opt.values
              .map((v) => `<button data-opt="${esc(opt.name)}" data-sw="${esc(v.name)}" title="${esc(v.name)}" class="${v.name === cur ? 'on' : ''}" style="background:${esc(v.color)}"></button>`)
              .join('')}</div>`
          : `<select data-opt="${esc(opt.name)}">${opt.values.map((v) => `<option ${v.name === cur ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`
      }</div>`);
    }
    const info = [];
    info.push(`${it.w} × ${it.d} × ${it.h} cm`);
    if (it.dims) {
      const L = { seatWidth: 'oturum eni', seatDepth: 'oturum derinliği', seatHeight: 'oturum yüksekliği', legHeight: 'ayak' };
      info.push(Object.entries(it.dims).map(([k, v]) => `${L[k] ?? k} ${v}`).join(' · ') + ' cm');
    }
    if (it.price) info.push(`<b>${Number(it.price).toLocaleString('tr-TR')} TL</b>${it.variant ? ` (seçili varyant)` : ''}`);
    if (it.material) info.push(esc(it.material));
    if (it.url) info.push(`<a href="${esc(it.url)}" target="_blank" rel="noopener">Ürün sayfası ↗</a>`);
    return `${parts.join('')}<p class="kv">${info.join('<br>')}</p>${it.source ? `<p class="kv">Kaynak: ${esc(it.source)}</p>` : ''}`;
  }

  /** Aynı türden ürünler: dokununca seçili mobilyanın yerine konur (konum korunur). */
  renderAlts(it, el) {
    const list = this.store.catalog.items.filter((c) => !c.set && (it.group ? c.group === it.group : c.category === it.category) && c.id !== it.ref);
    if (!list.length) {
      el.innerHTML = '<p class="note">Bu türde başka ürün yok. Katalog sekmesinden ekleyebilirsiniz.</p>';
      return;
    }
    el.innerHTML = list.map((c) => this.cardHtml(c, 'swap')).join('');
    this.bindCards(el);
  }

  cardHtml(c, mode = 'add') {
    const price = c.price ?? (c.variants ? Math.min(...Object.values(c.variants).map((v) => v.price)) : null);
    const sel = this.store.selection ? this.store.item(this.store.selection) : null;
    const swatches = (c.options ?? []).find((o) => o.values.some((v) => v.color));
    return `<div class="card" data-ref="${esc(c.id)}">
      <img class="thumb" alt="" data-thumb="${esc(c.id)}" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      <div class="card-body">
        <div class="card-title">${brandPrefix(c) ? `<span class="brand">${esc(c.brand)}</span> ` : ''}${esc(c.name)}</div>
        <div class="meta">${c.set ? `${c.set.length} parça · ` : ''}${c.w} × ${c.d} × ${c.h} cm${price ? ` · ${c.variants ? "'den " : ''}${Number(price).toLocaleString('tr-TR')} TL` : ''}${c.assumed ? ' · <span class="tag">örnek ölçü</span>' : c.sample ? ' · <span class="tag">örnek</span>' : ''}</div>
        ${swatches ? `<div class="swatches mini">${swatches.values.map((v) => `<span title="${esc(v.name)}" style="background:${esc(v.color)}"></span>`).join('')}</div>` : ''}
        <div class="card-actions">
          ${(mode === 'swap' || sel) && !c.set ? `<button class="primary" data-swap="${esc(c.id)}" ${sel ? '' : 'disabled'}>Yerine dene</button>` : ''}
          ${mode === 'add' ? `<button data-add="${esc(c.id)}">Ekle</button>` : ''}
          ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">Ürün ↗</a>` : ''}
        </div>
      </div>
    </div>`;
  }

  bindCards(root) {
    for (const b of root.querySelectorAll('[data-add]')) b.addEventListener('click', () => this.addProduct(b.dataset.add));
    for (const b of root.querySelectorAll('[data-swap]'))
      b.addEventListener('click', () => {
        const uid = this.store.selection;
        if (!uid) return this.toast('Önce evdeki bir mobilyaya dokunun; sonra "Yerine dene".');
        this.store.swap(uid, b.dataset.swap);
        this.toast(`${this.store.item(uid)?.name} denendi. Kontrol sonucu üstte; geri almak için ↶ ya da Ctrl+Z.`);
      });
    for (const img of root.querySelectorAll('img[data-thumb]')) {
      const c = this.store.catalogById.get(img.dataset.thumb);
      if (c) this.thumb(c, null, (url) => (img.src = url));
    }
  }

  addProduct(ref) {
    const c = this.store.catalogById.get(ref);
    // Aynı türden bir mobilya daha önce yerleştirildiyse yeni ürün onun son bırakıldığı yerde çıkar.
    const spot = this.store.spotFor(c);
    const p = spot ?? this.viewer.placementFor(c);
    if (c.set) {
      this.store.addSet(c, p.x, p.y, p.rot);
      if (this.isMobile()) this.el.panel.classList.add('collapsed');
      return this.toast(`${c.name}: ${c.set.length} parça eklendi. Her parçayı ayrı taşıyabilirsin.`, 6000);
    }
    this.store.add(ref, p.x, p.y, p.rot);
    if (!this.isMobile()) this.showTab('selected');
    else this.el.panel.classList.add('collapsed');
    const where = spot
      ? `Aynı türden (${c.group ?? 'mobilya'}) önceki mobilyanın son bırakıldığı yere kondu${spot.occupied ? '; eskisi hâlâ orada (Del ile silebilir ya da "Yerine dene" kullanabilirsin)' : ''}.`
      : this.viewer.mode === 'walk'
        ? 'Önünüze kondu.'
        : 'Sürükleyip yerleştirin.';
    this.toast(`${c.name} eklendi. ${where}`, 6000);
  }

  /** Seçili mobilyayı aynı türden önceki/sonraki ürünle değiştirir. */
  cycle(dir) {
    const it = this.store.selection ? this.store.item(this.store.selection) : null;
    if (!it) return;
    const list = this.store.catalog.items.filter((c) => !c.set && (it.group ? c.group === it.group : c.category === it.category));
    if (list.length < 2) return this.toast('Bu türde başka ürün yok.');
    const i = list.findIndex((c) => c.id === it.ref);
    const next = list[(i + dir + list.length) % list.length];
    this.store.swap(it.uid, next.id);
  }

  rotate(delta) {
    const it = this.store.selection ? this.store.item(this.store.selection) : null;
    if (it) this.store.update(it.uid, { rot: normAngle(Math.round((it.rot + delta) * 10) / 10) });
  }

  renderAdd() {
    const all = this.store.catalog.items;
    const groups = [...new Set(all.map((c) => c.group ?? c.category ?? 'Diğer'))];
    const g = this.catGroup ?? 'Tümü';
    const q = (this.catQuery ?? '').toLocaleLowerCase('tr');
    const realOnly = !!this.catReal;
    const list = all.filter(
      (c) =>
        (g === 'Tümü' || (c.group ?? c.category) === g) &&
        (!realOnly || c.brand) &&
        (!q || `${c.brand ?? ''} ${c.name}`.toLocaleLowerCase('tr').includes(q)),
    );
    const sel = this.store.selection ? this.store.item(this.store.selection) : null;
    this.el.add.innerHTML = `
      <div class="cat-filters">
        <input id="cat-q" type="search" placeholder="Ara: koltuk, TV, IKEA…" value="${esc(this.catQuery ?? '')}" aria-label="Katalogda ara">
        <label class="chk"><input id="cat-real" type="checkbox" ${realOnly ? 'checked' : ''}> Sadece gerçek ürünler</label>
        <div class="chips">${['Tümü', ...groups].map((x) => `<button data-g="${esc(x)}" class="${x === g ? 'on' : ''}">${esc(x)}</button>`).join('')}</div>
      </div>
      <p class="note">${sel ? `Seçili: <b>${esc(sel.name)}</b> — bir karttaki "Yerine dene" ile aynı yerde denenir.` : 'Evde bir mobilya seçiliyken "Yerine dene" ile aynı yerde değiştirebilirsiniz. "Ekle" görünümün ortasına (yürürken önünüze) koyar.'}</p>
      <div class="cards">${list.map((c) => this.cardHtml(c, 'add')).join('') || '<p class="note">Sonuç yok.</p>'}</div>
      <h3>Katalogda olmayan</h3>
      <div class="form">
        <label class="wide">Ad<input id="c-name" type="text" value="Özel mobilya"></label>
        <label>G<input id="c-w" type="number" value="100"></label>
        <label>D<input id="c-d" type="number" value="50"></label>
        <label>Y<input id="c-h" type="number" value="80"></label>
      </div>
      <div class="row"><button id="c-add">Kutu ekle</button></div>
      <p class="note">Ürün linki gönderirseniz ölçü, renk seçenekleri ve 3D modeliyle kataloğa eklerim; kalıcı katalog <code>public/data/furniture.json</code>.</p>`;
    const root = this.el.add;
    root.querySelector('#cat-q').addEventListener('input', (e) => {
      this.catQuery = e.target.value;
      clearTimeout(this._qt);
      this._qt = setTimeout(() => {
        this.renderAdd();
        const inp = this.el.add.querySelector('#cat-q');
        inp.focus();
        inp.setSelectionRange(inp.value.length, inp.value.length);
      }, 250);
    });
    root.querySelector('#cat-real').addEventListener('change', (e) => {
      this.catReal = e.target.checked;
      this.renderAdd();
    });
    for (const b of root.querySelectorAll('[data-g]'))
      b.addEventListener('click', () => {
        this.catGroup = b.dataset.g;
        this.renderAdd();
      });
    this.bindCards(root);
    root.querySelector('#c-add').addEventListener('click', () => {
      const v = (id) => root.querySelector(id).value;
      const w = Number(v('#c-w'));
      const d = Number(v('#c-d'));
      const h = Number(v('#c-h'));
      if (!(w > 0 && d > 0 && h > 0)) return this.toast('Ölçüler pozitif olmalı.');
      const p = this.viewer.placementFor({ w, d, h });
      this.store.add(null, p.x, p.y, p.rot, { name: v('#c-name') || 'Özel mobilya', w, d, h, color: '#94a3b8' });
      this.showTab('selected');
    });
  }

  renderLayouts() {
    const s = this.store;
    const l = s.active;
    const file = this.fileLayouts.find((f) => f.id === l.id);
    let html = `<h3>Aktif: ${esc(l.name)}</h3>
      <p class="note">${l.source === 'file' ? `Kaynak: <code>layouts/${esc(l.id)}.json</code>${l.modified ? ' · <b>tarayıcıda değiştirildi</b>' : ''}` : 'Yalnızca bu tarayıcıda kayıtlı (dışa aktarıp depoya ekleyebilirsiniz).'}</p>
      <div class="row">
        <button data-a="undo" ${s.canUndo() ? '' : 'disabled'}>↶ Geri al</button>
        <button data-a="redo" ${s.canRedo() ? '' : 'disabled'}>↷ Yinele</button>
      </div>
      <div class="row">
        <button data-a="copy">Kopyasını oluştur</button>
        <button data-a="new">Boş yerleşim</button>
        <button data-a="rename">Yeniden adlandır</button>
      </div>
      <div class="row" id="rename-row" hidden>
        <input id="rename-input" type="text" value="${esc(l.name)}" aria-label="Yeni ad" style="flex:2;min-width:0;border:1px solid var(--line);border-radius:7px;padding:6px 7px">
        <button data-a="rename-ok" class="primary">Kaydet</button>
      </div>
      <div class="row">
        ${this.embedded ? '' : '<button data-a="export">JSON indir</button>'}
        <button data-a="copyjson">JSON kopyala</button>
        <button data-a="import">JSON yükle</button>
        ${this.embedded ? '' : '<button data-a="share">Paylaşım linki</button>'}
      </div>
      <div class="row" id="copy-row" hidden><textarea id="copy-out" readonly rows="4" style="width:100%;font:11px ui-monospace,monospace"></textarea></div>
      <div class="row">
        ${l.source === 'file' && l.modified ? '<button data-a="reset">Dosyadaki haline dön</button>' : ''}
        ${l.source !== 'file' ? '<button data-a="delete" class="danger">Sil</button>' : ''}
      </div>
      <h3>Karşılaştır</h3>
      <p class="note">Tüm yerleşimler aynı kontrollerden geçirilir. Bir satıra dokunun: o yerleşime geçilir. "Hayalet" seçilen yerleşimi mor kesik çizgiyle üstüne çizer.</p>
      <div class="row"><button data-a="compare" class="primary">Karşılaştırmayı hesapla</button></div>
      <div id="cmp-out">${this.cmpRows ? this.cmpTable() : ''}</div>`;
    this.el.layouts.innerHTML = html;
    const act = {
      undo: () => s.undo(),
      redo: () => s.redo(),
      copy: () => s.createLayout(`${l.name} (kopya)`, l.id),
      new: () => s.createLayout('Yeni yerleşim'),
      rename: () => {
        const row = this.el.layouts.querySelector('#rename-row');
        row.hidden = false;
        row.querySelector('input').focus();
      },
      'rename-ok': () => {
        const n = this.el.layouts.querySelector('#rename-input').value.trim();
        if (n) s.renameLayout(l.id, n);
      },
      export: () => download(`${l.id}.json`, s.exportLayout(l.id)),
      copyjson: () => this.copyText(s.exportLayout(l.id), 'Yerleşim JSON\'u panoya kopyalandı.'),
      import: () => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = 'application/json,.json';
        inp.onchange = async () => {
          try {
            s.importLayout(JSON.parse(await inp.files[0].text()));
            this.toast('Yerleşim yüklendi.');
          } catch (err) {
            this.toast(`Yüklenemedi: ${err.message}`);
          }
        };
        inp.click();
      },
      share: async () => {
        const token = await encodeShare(l);
        const url = `${location.origin}${location.pathname}#y=${token}`;
        this.copyText(url, 'Link panoya kopyalandı. Telefonda açınca bu yerleşim yüklenir.');
      },
      reset: () => s.resetLayout(l.id, file),
      delete: () => {
        // İki adımlı silme (tarayıcı onay pencereleri her ortamda çalışmıyor).
        const b = this.el.layouts.querySelector('button[data-a="delete"]');
        if (b.dataset.armed) s.deleteLayout(l.id);
        else {
          b.dataset.armed = '1';
          b.textContent = `Eminim, "${l.name}" silinsin`;
        }
      },
      compare: async () => {
        this.el.layouts.querySelector('#cmp-out').innerHTML = '<p class="note">Hesaplanıyor…</p>';
        this.cmpRows = await this.compare();
        this.renderLayouts();
      },
    };
    for (const b of this.el.layouts.querySelectorAll('button[data-a]')) b.addEventListener('click', () => act[b.dataset.a]());
    for (const tr of this.el.layouts.querySelectorAll('tr[data-id]')) {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('input')) return;
        s.setActive(tr.dataset.id);
      });
    }
    for (const cb of this.el.layouts.querySelectorAll('input[data-ghost]')) {
      cb.addEventListener('change', () => {
        for (const o of this.el.layouts.querySelectorAll('input[data-ghost]')) if (o !== cb) o.checked = false;
        const lay = s.layouts.get(cb.dataset.ghost);
        this.viewer.setGhost(cb.checked && lay ? s.resolveLayout(lay) : null);
        this.ghostId = cb.checked ? cb.dataset.ghost : null;
      });
    }
  }

  /** Panoya kopyala; izin yoksa metni seçili bir kutuda göster. */
  copyText(text, okMsg) {
    const show = () => {
      const row = this.el.layouts.querySelector('#copy-row');
      if (!row) return;
      row.hidden = false;
      const ta = row.querySelector('textarea');
      ta.value = text;
      ta.select();
      this.toast('Kopyalama izni yok; metin aşağıda seçili.');
    };
    try {
      navigator.clipboard.writeText(text).then(() => this.toast(okMsg), show);
    } catch {
      show();
    }
  }

  cmpTable() {
    const rows = this.cmpRows
      .map(
        (r) => `<tr data-id="${esc(r.id)}" class="${r.id === this.store.activeId ? 'active' : ''}">
        <td>${esc(r.name)}</td>
        <td class="${r.m.errors ? 'e' : 'g'}">${r.m.errors}</td>
        <td class="${r.m.warnings ? 'w' : 'g'}">${r.m.warnings}</td>
        <td>${r.m.minPassage === null ? '–' : Math.round(r.m.minPassage)}</td>
        <td>%${Math.round(r.m.freePct ?? 0)}</td>
        <td><input type="checkbox" data-ghost="${esc(r.id)}" ${this.ghostId === r.id ? 'checked' : ''} title="Hayalet olarak göster"></td>
      </tr>`,
      )
      .join('');
    return `<table class="cmp"><tr><th>Yerleşim</th><th>Sorun</th><th>Uyarı</th><th>En dar</th><th>Boş</th><th>👻</th></tr>${rows}</table>
      <p class="note">En dar: girişten kapılara giden yollardaki en dar yer (cm). Boş: mobilyaların kaplamadığı zemin oranı.</p>`;
  }
}
