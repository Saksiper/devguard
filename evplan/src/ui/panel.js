// Yan panel: kontrol listesi, seçili mobilya düzenleyici, katalog, yerleşim yönetimi ve karşılaştırma.

import { normAngle } from '../core/geom.js';
import { encodeShare } from '../store.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SEV = { error: '!', warn: '!', info: 'i' };

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
    document.getElementById('panel-grip').addEventListener('click', () => this.el.panel.classList.toggle('collapsed'));
    this.el.select.addEventListener('change', () => store.setActive(this.el.select.value));
    this.renderAdd();
    this.renderLayouts();
    this.renderSelect();
    this.renderChecks();
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
    };
    for (const b of bar.querySelectorAll('button')) b.addEventListener('click', () => act[b.dataset.s]());
  }

  renderSelbar() {
    const it = this.store.selection ? this.store.item(this.store.selection) : null;
    const bar = this.el.selbar;
    bar.hidden = !it || this.viewer.mode === 'walk';
    if (!it) return;
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
      el.innerHTML = `<p class="note">Planda bir mobilyaya dokunun. Sürükleyerek taşıyın; iki parmakla çevirerek ya da aşağıdaki düğmelerle döndürün.</p>
        <p class="note">Klavye: oklar 1 cm (Shift 10 cm) · R / Shift+R 90° · Q / E 15° · Del sil · Ctrl+D çoğalt · Ctrl+Z geri al · Alt basılı sürükle = mıknatıssız</p>`;
      return;
    }
    const issues = (this.result?.issues ?? []).filter((i) => i.items.includes(it.uid));
    el.innerHTML = `
      <h3>${esc(it.name)}${it.assumed ? ' <span class="badge warn">örnek ölçü</span>' : ''}</h3>
      <div class="form">
        <label>Konum x (cm)<input type="number" step="1" data-k="x" value="${Math.round(it.x * 10) / 10}"></label>
        <label>Konum y (cm)<input type="number" step="1" data-k="y" value="${Math.round(it.y * 10) / 10}"></label>
        <label>Açı (°)<input type="number" step="5" data-k="rot" value="${Math.round(it.rot * 10) / 10}"></label>
        <label>Genişlik G<input type="number" step="1" data-k="w" value="${it.w}"></label>
        <label>Derinlik D<input type="number" step="1" data-k="d" value="${it.d}"></label>
        <label>Yükseklik Y<input type="number" step="1" data-k="h" value="${it.h}"></label>
        <label>Yerden (cm)<input type="number" step="1" data-k="z" value="${it.z}"></label>
        <label>Renk<input type="color" data-k="color" value="${esc(it.color)}"></label>
        <label>Ad<input type="text" data-k="name" value="${esc(it.name)}"></label>
      </div>
      <div class="row">
        <button data-a="r-90" title="Shift+R">⟲ 90°</button>
        <button data-a="r-15" title="Q">⟲ 15°</button>
        <button data-a="r15" title="E">⟳ 15°</button>
        <button data-a="r90" title="R">⟳ 90°</button>
      </div>
      <div class="row">
        <button data-a="dup">Çoğalt</button>
        <button data-a="reset" title="Bu yerleşimde değiştirilen ölçü/renk/adı katalogdakine döndür">Kataloğa dön</button>
        <button data-a="del" class="danger">Sil</button>
      </div>
      <p class="kv">Katalog: ${esc(it.ref ?? 'özel')}${it.url ? ` · <a href="${esc(it.url)}" target="_blank" rel="noopener">ürün linki</a>` : ''}${it.model ? ` · model: ${esc(it.model)}` : ''}</p>
      <p class="kv">Ölçüyü burada değiştirmek yalnızca bu yerleşimi etkiler. Kalıcı ürün ölçüsü için <code>furniture.json</code> düzenlenir.</p>
      ${issues.length ? `<h3>Bu mobilyanın sorunları</h3><ol class="issues">${issues.map((is) => `<li class="${is.severity}"><span class="dot">${SEV[is.severity]}</span><span>${esc(is.text)}</span></li>`).join('')}</ol>` : ''}
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
  }

  rotate(delta) {
    const it = this.store.selection ? this.store.item(this.store.selection) : null;
    if (it) this.store.update(it.uid, { rot: normAngle(Math.round((it.rot + delta) * 10) / 10) });
  }

  renderAdd() {
    const groups = new Map();
    for (const it of this.store.catalog.items) {
      const g = it.category || 'Diğer';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(it);
    }
    let html = '<p class="note">Dokunduğunuz mobilya görünümün ortasına eklenir; sonra sürükleyip yerleştirin.</p>';
    for (const [g, list] of groups) {
      html += `<h3>${esc(g)}</h3><div class="catalog">`;
      for (const it of list) {
        html += `<button class="cat-item" data-ref="${esc(it.id)}"><span class="sw" style="background:${esc(it.color)}"></span>
          <span><div>${esc(it.name)}</div><div class="meta">${it.w} × ${it.d} × ${it.h} cm</div></span>
          ${it.assumed ? '<span class="tag">örnek</span>' : ''}</button>`;
      }
      html += '</div>';
    }
    html += `<h3>Katalogda olmayan</h3>
      <div class="form">
        <label class="wide">Ad<input id="c-name" type="text" value="Özel mobilya"></label>
        <label>G<input id="c-w" type="number" value="100"></label>
        <label>D<input id="c-d" type="number" value="50"></label>
        <label>Y<input id="c-h" type="number" value="80"></label>
      </div>
      <div class="row"><button id="c-add">Kutu ekle</button></div>
      <p class="note">Kalıcı olması için ürünü <code>public/data/furniture.json</code> dosyasına ekleyin (ölçü, renk, link, isteğe bağlı GLB modeli).</p>`;
    this.el.add.innerHTML = html;
    for (const b of this.el.add.querySelectorAll('.cat-item'))
      b.addEventListener('click', () => {
        const [x, y] = this.viewer.viewCenter();
        this.store.add(b.dataset.ref, x, y, 0);
        this.showTab('selected');
      });
    this.el.add.querySelector('#c-add').addEventListener('click', () => {
      const v = (id) => this.el.add.querySelector(id).value;
      const w = Number(v('#c-w'));
      const d = Number(v('#c-d'));
      const h = Number(v('#c-h'));
      if (!(w > 0 && d > 0 && h > 0)) return this.toast('Ölçüler pozitif olmalı.');
      const [x, y] = this.viewer.viewCenter();
      this.store.add(null, x, y, 0, { name: v('#c-name') || 'Özel mobilya', w, d, h, color: '#94a3b8' });
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
