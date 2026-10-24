// plan.json / furniture.json / yerleşim dosyaları için okunur Türkçe hata mesajları.
// Amaç: JSON'u elle düzenlerken yapılan hatayı kod açmadan bulabilmek.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPt = (v) => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

export function validatePlan(plan) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== 'object') return { errors: ['plan.json okunamadı.'], warnings };
  const ids = new Set();
  const dup = (id, what) => {
    if (!id) errors.push(`${what}: "id" alanı eksik.`);
    else if (ids.has(id)) errors.push(`${what}: "${id}" kimliği birden fazla kez kullanılmış.`);
    ids.add(id);
  };

  const walls = new Map();
  (plan.walls ?? []).forEach((w, i) => {
    const where = `walls[${i}]${w.id ? ` (${w.id})` : ''}`;
    dup(w.id, where);
    if (!isPt(w.from) || !isPt(w.to)) errors.push(`${where}: "from" ve "to" [x, y] olmalı (cm).`);
    else if (w.from[0] === w.to[0] && w.from[1] === w.to[1]) errors.push(`${where}: uzunluğu 0.`);
    if (w.thickness !== undefined && !(isNum(w.thickness) && w.thickness > 0))
      errors.push(`${where}: "thickness" pozitif sayı olmalı.`);
    if (w.side !== undefined && !['left', 'right', 'center'].includes(w.side))
      errors.push(`${where}: "side" left / right / center olmalı.`);
    if (w.id) walls.set(w.id, w);
  });
  if (!walls.size) errors.push('Hiç duvar tanımlanmamış ("walls").');

  (plan.openings ?? []).forEach((o, i) => {
    const where = `openings[${i}]${o.id ? ` (${o.id})` : ''}`;
    dup(o.id, where);
    if (!['door', 'window'].includes(o.type)) errors.push(`${where}: "type" door veya window olmalı.`);
    const w = walls.get(o.wall);
    if (!w) {
      errors.push(`${where}: "wall" = "${o.wall}" adlı duvar yok.`);
      return;
    }
    if (!isNum(o.offset) || !isNum(o.width) || o.width <= 0)
      errors.push(`${where}: "offset" ve "width" sayı olmalı (cm).`);
    else if (isPt(w.from) && isPt(w.to)) {
      const L = Math.hypot(w.to[0] - w.from[0], w.to[1] - w.from[1]);
      if (o.offset < 0 || o.offset + o.width > L + 0.5)
        errors.push(
          `${where}: duvar ${o.wall} ${L.toFixed(0)} cm; açıklık ${o.offset}–${o.offset + o.width} cm aralığı duvarın dışına taşıyor.`,
        );
    }
    if (o.swing !== undefined && !['left', 'right', 'none'].includes(o.swing))
      errors.push(`${where}: "swing" left / right / none olmalı.`);
    if (o.hinge !== undefined && !['start', 'end'].includes(o.hinge))
      errors.push(`${where}: "hinge" start veya end olmalı.`);
    if (o.type === 'door' && o.swing === undefined)
      warnings.push(`${where}: kapının açılma yönü ("swing") yok; açılma alanı kontrol edilmeyecek.`);
  });

  (plan.rooms ?? []).forEach((r, i) => {
    const where = `rooms[${i}]${r.id ? ` (${r.id})` : ''}`;
    dup(r.id, where);
    if (!Array.isArray(r.polygon) || r.polygon.length < 3 || !r.polygon.every(isPt))
      errors.push(`${where}: "polygon" en az 3 köşeli [[x,y], ...] olmalı.`);
  });
  if (!(plan.rooms ?? []).length) warnings.push('Oda tanımı yok ("rooms"); "ev dışında" ve geçiş kontrolleri çalışmaz.');

  (plan.fixtures ?? []).forEach((f, i) => {
    const where = `fixtures[${i}]${f.id ? ` (${f.id})` : ''}`;
    dup(f.id, where);
    for (const k of ['x', 'y', 'w', 'd', 'h'])
      if (!isNum(f[k])) errors.push(`${where}: "${k}" sayı olmalı (cm).`);
  });

  return { errors, warnings };
}

export function validateCatalog(catalog) {
  const errors = [];
  const items = catalog?.items;
  if (!Array.isArray(items)) return { errors: ['furniture.json içinde "items" listesi yok.'], warnings: [] };
  const ids = new Set();
  items.forEach((it, i) => {
    const where = `items[${i}]${it.id ? ` (${it.id})` : ''}`;
    if (!it.id) errors.push(`${where}: "id" eksik.`);
    else if (ids.has(it.id)) errors.push(`${where}: "${it.id}" iki kez tanımlı.`);
    ids.add(it.id);
    for (const k of ['w', 'd', 'h'])
      if (!(isNum(it[k]) && it[k] > 0)) errors.push(`${where}: "${k}" pozitif sayı olmalı (cm).`);
  });
  return { errors, warnings: [] };
}

export function validateLayout(layout, catalog) {
  const errors = [];
  const known = new Set((catalog?.items ?? []).map((i) => i.id));
  if (!Array.isArray(layout?.items)) return { errors: ['Yerleşimde "items" listesi yok.'], warnings: [] };
  layout.items.forEach((it, i) => {
    const where = `${layout.name ?? layout.id}: items[${i}]`;
    if (!it.ref && !(isNum(it.w) && isNum(it.d) && isNum(it.h)))
      errors.push(`${where}: "ref" (katalog id) ya da w/d/h verilmeli.`);
    else if (it.ref && !known.has(it.ref)) errors.push(`${where}: katalogda "${it.ref}" yok.`);
    if (!isNum(it.x) || !isNum(it.y)) errors.push(`${where}: "x" ve "y" sayı olmalı (cm).`);
  });
  return { errors, warnings: [] };
}
