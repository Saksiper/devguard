// Uygulama durumu: aktif yerleşim, seçim, geri al/yinele, tarayıcıda saklama, paylaşım linki.
//
// Dosyadan gelen yerleşimler (public/data/layouts/*.json) salt okunur kaynaktır; üzerlerinde yapılan
// değişiklikler tarayıcıda (localStorage) saklanır. Dosya sonradan değişirse dosya kazanır, yerel
// değişiklikler "(yerel kopya)" adıyla ayrı yerleşim olarak korunur.

import { newUid, resolveItem } from './core/items.js';

const VERSION = 1;

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function safeStorage() {
  try {
    const k = '__evplan_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}

function slug(s) {
  return (
    s
      .toLocaleLowerCase('tr')
      .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c])
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'yerlesim'
  );
}

export class Store extends EventTarget {
  constructor({ plan, catalog, fileLayouts }) {
    super();
    this.plan = plan;
    this.catalog = catalog;
    this.catalogById = new Map(catalog.items.map((i) => [i.id, i]));
    this.storage = safeStorage();
    this.key = `evplan:v${VERSION}:${plan.meta?.id ?? plan.meta?.name ?? 'plan'}`;
    this.layouts = new Map();
    this.order = [];
    this.selection = null;
    this.undoStack = new Map();
    this.redoStack = new Map();
    this._resolved = null;
    this._dragBase = null;

    const saved = this._load();
    for (const f of fileLayouts) {
      const fileHash = hash(JSON.stringify(f));
      const local = saved?.layouts?.[f.id];
      const layout = { ...clone(f), source: 'file', fileHash, modified: false };
      if (local && local.source === 'file') {
        if (local.fileHash === fileHash) {
          layout.items = local.items;
          layout.name = local.name ?? layout.name;
          layout.modified = !!local.modified;
        } else if (local.modified) {
          // Dosya değişmiş: dosyayı kullan, yereldeki değişiklikleri ayrı kopya olarak sakla.
          const copyId = `${f.id}-yerel`;
          this._put({ ...local, id: copyId, name: `${local.name ?? f.name} (yerel kopya)`, source: 'local' });
        }
      }
      this._put(layout);
    }
    for (const l of Object.values(saved?.layouts ?? {})) {
      if (l.source === 'local' && !this.layouts.has(l.id)) this._put(l);
    }
    if (!this.layouts.size) this._put({ id: 'bos', name: 'Boş yerleşim', items: [], source: 'local' });
    const wanted = saved?.activeId;
    this.activeId = this.layouts.has(wanted) ? wanted : this.order[0];
    this._ensureUids();
  }

  _put(layout) {
    if (!this.layouts.has(layout.id)) this.order.push(layout.id);
    this.layouts.set(layout.id, layout);
  }

  _ensureUids() {
    for (const l of this.layouts.values())
      for (const it of l.items) if (!it.uid) it.uid = newUid();
  }

  _load() {
    if (!this.storage) return null;
    try {
      return JSON.parse(this.storage.getItem(this.key) ?? 'null');
    } catch {
      return null;
    }
  }

  persist() {
    if (!this.storage) return;
    const layouts = {};
    for (const l of this.layouts.values()) {
      if (l.source === 'file' && !l.modified) continue;
      layouts[l.id] = l;
    }
    try {
      this.storage.setItem(this.key, JSON.stringify({ activeId: this.activeId, layouts }));
    } catch {
      /* kota dolu olabilir; sessizce geç */
    }
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { type, ...detail } }));
  }

  get active() {
    return this.layouts.get(this.activeId);
  }

  list() {
    return this.order.map((id) => this.layouts.get(id));
  }

  /** Aktif yerleşimin katalogla birleştirilmiş mobilyaları (önbellekli). */
  items() {
    if (!this._resolved) this._resolved = this.active.items.map((e) => resolveItem(e, this.catalogById));
    return this._resolved;
  }

  resolveLayout(layout) {
    return layout.items.map((e) => resolveItem(e, this.catalogById));
  }

  item(uid) {
    return this.items().find((i) => i.uid === uid) ?? null;
  }

  _changed(type, detail) {
    this._resolved = null;
    const l = this.active;
    if (l.source === 'file') l.modified = true;
    this.persist();
    this.emit(type, detail);
  }

  _snapshot() {
    const id = this.activeId;
    if (!this.undoStack.has(id)) this.undoStack.set(id, []);
    const st = this.undoStack.get(id);
    st.push(JSON.stringify(this.active.items));
    if (st.length > 100) st.shift();
    this.redoStack.set(id, []);
  }

  setActive(id) {
    if (!this.layouts.has(id) || id === this.activeId) return;
    this.activeId = id;
    this.selection = null;
    this._resolved = null;
    this.persist();
    this.emit('layout');
  }

  select(uid) {
    if (this.selection === uid) return;
    this.selection = uid;
    this.emit('select');
  }

  /** Sürükleme başlangıcı: tek bir geri alma adımı için durum saklanır. */
  beginDrag() {
    this._dragBase = JSON.stringify(this.active.items);
  }

  endDrag() {
    if (this._dragBase === null) return;
    const now = JSON.stringify(this.active.items);
    if (now !== this._dragBase) {
      const id = this.activeId;
      if (!this.undoStack.has(id)) this.undoStack.set(id, []);
      this.undoStack.get(id).push(this._dragBase);
      this.redoStack.set(id, []);
      this._changed('commit');
    }
    this._dragBase = null;
  }

  update(uid, patch, { live = false } = {}) {
    const e = this.active.items.find((i) => i.uid === uid);
    if (!e) return;
    if (!live && this._dragBase === null) this._snapshot();
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === null || v === '') delete e[k];
      else e[k] = v;
    }
    if (live) {
      this._resolved = null;
      this.emit('live', { uid });
    } else this._changed('commit', { uid });
  }

  add(ref, x, y, rot = 0, extra = {}) {
    this._snapshot();
    const uid = newUid();
    this.active.items.push({ uid, ref, x: Math.round(x), y: Math.round(y), rot, ...extra });
    this.selection = uid;
    this._changed('commit', { uid });
    return uid;
  }

  remove(uid) {
    this._snapshot();
    this.active.items = this.active.items.filter((i) => i.uid !== uid);
    if (this.selection === uid) this.selection = null;
    this._changed('commit');
  }

  duplicate(uid) {
    const e = this.active.items.find((i) => i.uid === uid);
    if (!e) return null;
    this._snapshot();
    const copy = { ...clone(e), uid: newUid(), x: e.x + 20, y: e.y + 20 };
    this.active.items.push(copy);
    this.selection = copy.uid;
    this._changed('commit', { uid: copy.uid });
    return copy.uid;
  }

  undo() {
    const st = this.undoStack.get(this.activeId);
    if (!st?.length) return false;
    if (!this.redoStack.has(this.activeId)) this.redoStack.set(this.activeId, []);
    this.redoStack.get(this.activeId).push(JSON.stringify(this.active.items));
    this.active.items = JSON.parse(st.pop());
    this._changed('commit');
    return true;
  }

  redo() {
    const st = this.redoStack.get(this.activeId);
    if (!st?.length) return false;
    this.undoStack.get(this.activeId)?.push(JSON.stringify(this.active.items));
    this.active.items = JSON.parse(st.pop());
    this._changed('commit');
    return true;
  }

  canUndo() {
    return !!this.undoStack.get(this.activeId)?.length;
  }

  canRedo() {
    return !!this.redoStack.get(this.activeId)?.length;
  }

  _uniqueId(base) {
    let id = slug(base);
    let k = 2;
    while (this.layouts.has(id)) id = `${slug(base)}-${k++}`;
    return id;
  }

  createLayout(name, fromId = null) {
    const src = fromId ? this.layouts.get(fromId) : null;
    const id = this._uniqueId(name);
    const items = src ? clone(src.items).map((i) => ({ ...i, uid: newUid() })) : [];
    this._put({ id, name, items, source: 'local' });
    this.activeId = id;
    this.selection = null;
    this._resolved = null;
    this.persist();
    this.emit('layout');
    return id;
  }

  renameLayout(id, name) {
    const l = this.layouts.get(id);
    if (!l || !name) return;
    l.name = name;
    if (l.source === 'file') l.modified = true;
    this.persist();
    this.emit('layout');
  }

  deleteLayout(id) {
    const l = this.layouts.get(id);
    if (!l || l.source === 'file') return false;
    this.layouts.delete(id);
    this.order = this.order.filter((x) => x !== id);
    if (this.activeId === id) this.activeId = this.order[0];
    this._resolved = null;
    this.persist();
    this.emit('layout');
    return true;
  }

  /** Dosyadan gelen yerleşimi dosyadaki haline döndürür. */
  resetLayout(id, fileLayout) {
    const l = this.layouts.get(id);
    if (!l || l.source !== 'file' || !fileLayout) return;
    this._snapshot();
    l.items = clone(fileLayout.items);
    l.name = fileLayout.name;
    l.modified = false;
    this._ensureUids();
    this._resolved = null;
    this.persist();
    this.emit('layout');
  }

  exportLayout(id) {
    const l = this.layouts.get(id);
    const out = {
      id: l.id,
      name: l.name,
      note: l.note,
      items: l.items.map((i) => {
        const o = { ...i };
        o.x = Math.round(o.x * 10) / 10;
        o.y = Math.round(o.y * 10) / 10;
        o.rot = Math.round((o.rot ?? 0) * 10) / 10;
        return o;
      }),
    };
    return JSON.stringify(out, null, 2);
  }

  importLayout(obj, nameSuffix = '') {
    if (!obj || !Array.isArray(obj.items)) throw new Error('Geçersiz yerleşim dosyası ("items" yok).');
    const name = `${obj.name ?? 'İçe aktarılan'}${nameSuffix}`;
    const id = this._uniqueId(name);
    this._put({ id, name, items: obj.items.map((i) => ({ ...i, uid: i.uid ?? newUid() })), source: 'local' });
    this.activeId = id;
    this.selection = null;
    this._resolved = null;
    this.persist();
    this.emit('layout');
    return id;
  }
}

// Paylaşım linki: yerleşim → sıkıştırılmış base64url (#y=...). Sunucu gerektirmez.
function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeShare(layout) {
  const json = JSON.stringify({
    name: layout.name,
    items: layout.items.map(({ uid, ...rest }) => {
      void uid;
      return rest;
    }),
  });
  const raw = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'function') return `z.${b64u(await pipe(raw, new CompressionStream('deflate-raw')))}`;
  return `j.${b64u(raw)}`;
}

export async function decodeShare(token) {
  const [kind, data] = [token.slice(0, 1), token.slice(2)];
  let bytes = unb64u(data);
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  return JSON.parse(new TextDecoder().decode(bytes));
}
