// Oda-poligonu tabanlı ev modelini (metre; odalar + kenar bazlı açıklıklar + petek + ankastre)
// evplan'ın plan.json biçimine (cm; duvarlar + açıklıklar + sabit engeller) çevirir.
//
// Komut satırı: node scripts/import-model.mjs <model.json> <çıktı-klasörü>
//
// Kaynak modelde: x = plan sağı, z = plan aşağısı, y = yukarı (metre). Odaların poligonu iç yüzlerdir;
// duvarlar poligonun dışına doğru meta.wall_thickness_assumed kalınlığında çizilir.
// Bilinmeyen her şey çıktıda "assumed": true ve "note" ile işaretlenir.

export function convertModel(M, sourceName = 'model.json') {
  const cm = (v) => Math.round(v * 1000) / 10; // m → cm, 1 mm hassasiyet
  const P = ([x, z]) => [cm(x), cm(z)];

  function inside([x, y], poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  }

  /** Kenar geometrisi (cm): yön, dışa normal ve evplan "side" değeri. */
  function edgeOf(poly, i) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const d = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const left = [d[1], -d[0]];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const leftIsInside = inside([mid[0] + left[0] * 2, mid[1] + left[1] * 2], poly);
    const out = leftIsInside ? [-left[0], -left[1]] : left;
    return {
      a,
      b,
      L,
      d,
      out,
      inward: [-out[0], -out[1]],
      side: leftIsInside ? 'right' : 'left',
      inSide: leftIsInside ? 'left' : 'right',
    };
  }

  const angle = (d) => Math.round(((Math.atan2(d[1], d[0]) * 180) / Math.PI) * 100) / 100;
  const at = (e, s, o) => [e.a[0] + e.d[0] * s + e.inward[0] * o, e.a[1] + e.d[1] * s + e.inward[1] * o];
  const r1 = (v) => Math.round(v * 10) / 10;

  const T = cm(M._meta?.wall_thickness_assumed ?? 0.1);
  const nameOf = (m) => (typeof m === 'string' ? m : (m?.name ?? ''));
  const FLOOR = (txt = '') => (/seramik|fayans|karo/i.test(txt) ? 'seramik' : /parke|laminat/i.test(txt) ? 'parke' : 'parke');
  const DECOR = new Set(['oven', 'ovenGlass', 'hob', 'steel', 'seam']); // başka kutunun üstünde/içinde ince yüzeyler

  // Komşu odaya taşmasın: duvar kalınlığı, kenarın dışındaki en yakın odaya olan boşlukla sınırlanır.
  function raySeg(o, d, a, b) {
    const e = [b[0] - a[0], b[1] - a[1]];
    const den = d[0] * e[1] - d[1] * e[0];
    if (Math.abs(den) < 1e-9) return null;
    const w = [a[0] - o[0], a[1] - o[1]];
    const t = (w[0] * e[1] - w[1] * e[0]) / den;
    const u = (w[0] * d[1] - w[1] * d[0]) / den;
    return t > -1e-6 && u >= 0 && u <= 1 ? t : null;
  }
  function outwardGap(e, others) {
    let gap = Infinity;
    for (let k = 0; k <= 8; k++) {
      const s = 0.02 + (0.96 * k) / 8;
      const o = [e.a[0] + (e.b[0] - e.a[0]) * s, e.a[1] + (e.b[1] - e.a[1]) * s];
      for (const poly of others)
        for (let i = 0; i < poly.length; i++) {
          const t = raySeg(o, e.out, poly[i], poly[(i + 1) % poly.length]);
          if (t !== null && t < gap) gap = t;
        }
    }
    return gap;
  }
  const allPolys = [...M.rooms.map((r) => r.polygon.map(P)), ...(M.balconies ?? []).map((b) => b.polygon.map(P))];
  const thin = [];

  const walls = [];
  const openings = [];
  let entranceDoor = null;
  const inAnyRoom = (p) => allPolys.some((q) => inside(p, q));
  const rooms = [];
  const fixtures = [];
  const notes = [];
  const ceilings = M.rooms.map((r) => cm(r.ceiling_height));

  for (const r of M.rooms) {
    const poly = r.polygon.map(P);
    const H = cm(r.ceiling_height);
    rooms.push({
      id: r.id,
      name: r.name,
      polygon: poly,
      floor: FLOOR(r.floor),
      floorNote: r.floor,
      ceilingHeight: H,
      reference: r.reference_size ?? r.magicplan,
      status: r.status,
      source: r.sources,
      notes: r.notes,
    });
    for (const n of r.notes ?? []) notes.push(`${r.name}: ${n}`);
    const skip = new Set(r.walls_not_drawn ?? []); // komşu odanın duvarıyla çakışan kenar: duvar çizilmez
    const E = poly.map((_, i) => edgeOf(poly, i));
    const others = allPolys.filter((q) => q !== allPolys[M.rooms.indexOf(r)]);
    E.forEach((e, i) => {
      if (skip.has(i)) return;
      const gap = outwardGap(e, others);
      const t = Math.max(1, Math.min(T, Math.floor(gap * 10) / 10));
      if (t < T) thin.push(`${r.name} ${i + 1}. kenar: komşuya boşluk ${r1(gap)} cm → duvar ${t} cm çizildi`);
      walls.push({
        id: `${r.id}-${i + 1}`,
        from: e.a,
        to: e.b,
        thickness: t,
        side: e.side,
        height: H,
        room: r.id,
        assumed: true,
        note: t < T ? `komşu odaya boşluk ${r1(gap)} cm; duvar inceltildi` : `kalınlık ${T} cm varsayım`,
      });
    });

    let k = 0;
    for (const o of r.openings ?? []) {
      const e = E[o.edge];
      const wall = `${r.id}-${o.edge + 1}`;
      const off = cm(o.offset_from_edge_start);
      const width = cm(o.width);
      const head = cm(o.head ?? r.ceiling_height);
      if (o.type === 'kapı' || /sürgü/i.test(o.type)) {
        k++;
        const sliding = /sürgü/i.test(o.type);
        // Kapının öbür tarafı modelde yoksa (ölçülmemiş koridor, merdiven sahanlığı) oradan "girilir".
        const beyond = at(e, off + width / 2, -(T + 30));
        const id = `${r.id}-kapi${k}`;
        if (/giriş|daire kapı/i.test(o.label ?? '') && !entranceDoor) entranceDoor = id;
        openings.push({
          id,
          name: `${r.name}: ${o.label}`,
          type: 'door',
          wall,
          offset: off,
          width,
          height: head,
          ...(sliding
            ? { swing: 'none', sliding: o.pocket ? 'pocket' : true }
            : { hinge: o.hinge_at ?? 'start', swing: /dışına/i.test(o.swings ?? '') ? e.side : e.inSide }),
          glassLeaf: !!o.glass_leaf,
          ...(o.closed ? { closed: true } : {}),
          ...(/çelik/i.test(o.label ?? '') ? { leafMaterial: 'steel' } : {}),
          entrance: inAnyRoom(beyond) ? undefined : true,
          source: o.source,
          note: sliding
            ? `sürgülü${o.pocket ? ' (cep: kanat duvarın içine kayar)' : ''}; açılma alanı yok`
            : 'genişlik Magicplan açıklığı; net geçiş (kasa içi) ölçülmedi',
        });
        continue;
      }
      // Cam: kanatlara böl; art arda açılan kanatlar camlı kapı, sabitler pencere (denizlik 0 ise yer camı).
      const n = Math.max(1, o.panels ?? 1);
      const pw = width / n;
      const open = new Set(o.opening_panels ?? []);
      let i = 0;
      while (i < n) {
        const isOpen = open.has(i);
        let j = i;
        while (j + 1 < n && open.has(j + 1) === isOpen) j++;
        const cnt = j - i + 1;
        const s0 = r1(off + pw * i);
        const w0 = r1(pw * cnt);
        k++;
        if (isOpen) {
          let hinge;
          if (cnt === 1) {
            // Tek kanat: en yakın oda köşesine doğru menteşe (duvara yaslanarak açılır) — tahmin.
            const toStart = s0;
            const toEnd = e.L - (s0 + w0);
            hinge = toStart <= toEnd ? 'start' : 'end';
            if (n > 1) hinge = i === 0 ? 'start' : j === n - 1 ? 'end' : 'start';
          }
          openings.push({
            id: `${r.id}-cam${k}`,
            name: `${r.name}: ${o.label}${n > 1 ? ` (açılan kanat${cnt > 1 ? 'lar' : ''})` : ''}`,
            type: 'door',
            wall,
            offset: s0,
            width: w0,
            height: head - cm(o.sill ?? 0),
            sill: cm(o.sill ?? 0),
            leaves: cnt,
            hinge,
            swing: e.inSide,
            glazed: true,
            assumed: true,
            note: 'kanadın içe açıldığı ve menteşe tarafı tahmin',
            source: o.source,
          });
        } else {
          openings.push({
            id: `${r.id}-cam${k}`,
            name: `${r.name}: ${o.label} (sabit)`,
            type: 'window',
            wall,
            offset: s0,
            width: w0,
            sill: cm(o.sill ?? 0),
            height: head - cm(o.sill ?? 0),
            source: o.source,
          });
        }
        i = j + 1;
      }
    }

    for (const [q, f] of (r.radiators ?? []).entries()) {
      const e = E[f.edge];
      const gap = cm(f.wall_gap ?? 0.045);
      // depth_from_wall: duvardan petek önüne toplam çıkıntı (boşluk dahil).
      const dep = f.depth_from_wall !== undefined ? r1(cm(f.depth_from_wall) - gap) : cm(f.depth ?? 0.09);
      const [x, y] = at(e, cm(f.center_offset_from_edge_start), gap + dep / 2);
      fixtures.push({
        id: `${r.id}-petek${q + 1}`,
        type: 'radiator',
        name: f.label,
        x: r1(x),
        y: r1(y),
        w: cm(f.width),
        d: dep,
        h: cm(f.height),
        z: cm(f.bottom),
        rot: angle(e.d),
        source: f.source,
      });
    }

    if (r.ceiling_beam) {
      const b = r.ceiling_beam;
      const e = E[b.edge];
      const dep = cm(b.depth);
      const [x, y] = at(e, e.L / 2, dep / 2);
      fixtures.push({
        id: `${r.id}-kiris`,
        type: 'beam',
        name: `Tavan kirişi (${r.name})`,
        x: r1(x),
        y: r1(y),
        w: r1(e.L),
        d: dep,
        h: cm(b.drop),
        z: cm(b.bottom),
        rot: angle(e.d),
        assumed: true,
        source: b.source,
      });
    }

    for (const [q, b] of (r.built_ins ?? []).entries()) {
      const x = b.box;
      fixtures.push({
        id: `${r.id}-ank${q + 1}`,
        type: 'builtin',
        material: b.material,
        name: b.label ?? 'Ankastre',
        x: r1((cm(x.x0) + cm(x.x1)) / 2),
        y: r1((cm(x.z0) + cm(x.z1)) / 2),
        w: r1(cm(x.x1) - cm(x.x0)),
        d: r1(cm(x.z1) - cm(x.z0)),
        h: r1(cm(x.y1) - cm(x.y0)),
        z: cm(x.y0),
        // Kaynak "obstacle" yalnızca yerde engel demek; burada yükseklikli kontrol yapıldığı için
        // ince süs yüzeyleri dışındaki her şey (üst dolap, tezgâh) çakışır.
        collides: !DECOR.has(b.material),
      });
    }

    for (const [q, c] of (r.cylinders ?? []).entries()) {
      const d = cm(c.radius * 2);
      fixtures.push({
        id: `${r.id}-silindir${q + 1}`,
        type: 'post',
        shape: 'cylinder',
        material: c.material,
        name: c.radius >= 0.02 ? 'Masa ayağı' : 'Batarya',
        x: cm(c.x),
        y: cm(c.z),
        w: d,
        d,
        h: cm(c.y1 - c.y0),
        z: cm(c.y0),
        collides: c.radius >= 0.02,
      });
    }

    for (const [q, l] of (r.pendant_lights ?? []).entries()) {
      fixtures.push({
        id: `${r.id}-lamba${q + 1}`,
        type: 'lamp',
        shape: 'cylinder',
        name: r.lights_source && /tahmin/i.test(r.lights_source) ? 'Sarkıt lamba (konum tahmini)' : 'Sarkıt lamba',
        x: cm(l.x),
        y: cm(l.z),
        w: 35,
        d: 35,
        h: 20,
        z: r1(H - cm(l.drop)),
        collides: false,
        assumed: true,
      });
    }
  }

  for (const [q, b] of (M.balconies ?? []).entries()) {
    const id = `balkon${q + 1}`;
    const poly = b.polygon.map(P);
    // Kısa ad (planda okunur kalsın); uzun ad "fullName" olarak saklanır.
    const short = /\+/.test(b.name) ? b.name.split('+')[0].trim() : /fransız/i.test(b.name) ? 'fransız balkon' : b.name;
    rooms.push({
      id,
      name: short.replace(/^./, (c) => c.toLocaleUpperCase('tr')),
      fullName: b.name,
      polygon: poly,
      floor: 'dis',
      ceiling: false,
      assumed: true,
      source: b.source ?? b.note,
    });
    const E = poly.map((_, i) => edgeOf(poly, i));
    for (const i of b.railing_edges ?? [])
      walls.push({
        id: `${id}-korkuluk${i + 1}`,
        from: E[i].a,
        to: E[i].b,
        thickness: 5,
        side: E[i].side,
        height: cm(b.railing_height ?? 1.05),
        kind: 'parapet',
        assumed: true,
      });
    for (const i of b.wall_edges ?? [])
      walls.push({
        id: `${id}-duvar${i + 1}`,
        from: E[i].a,
        to: E[i].b,
        thickness: T,
        side: E[i].side,
        height: Math.max(...ceilings),
        assumed: true,
      });
  }

  // Konum ve yön (güneş için): "+x = kuzey" gibi eksen tarifinden kuzeyin plan açısı.
  const AZ = { kuzey: 0, 'doğu': 90, 'güney': 180, 'batı': 270 };
  const azOf = (t) => {
    const k = Object.keys(AZ).find((n) => String(t ?? '').toLocaleLowerCase('tr').includes(`= ${n}`));
    return k === undefined ? null : AZ[k];
  };
  const cs = M._meta?.coordinate_system ?? {};
  const raw = azOf(cs.x) !== null ? -azOf(cs.x) : azOf(cs.z) !== null ? 90 - azOf(cs.z) : null;
  const north = raw === null ? null : (raw + 360) % 360;
  const loc = M._meta?.location;
  const site =
    loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
      ? { city: loc.city, lat: loc.lat, lon: loc.lon, utcOffset: loc.utcOffset ?? 3, northAngle: north ?? 0, ...(north === null ? { assumed: true } : {}) }
      : null;

  const missing = (M.missing ?? []).map((m) => nameOf(m) + (m?.note ? ` — ${m.note}` : ''));
  const recess = cs.facade_recess;
  if (recess) notes.push(`Cephe girintisi ${cm(recess.value_m)} cm: ${recess.note}`);
  const open = openings.filter((o) => o.entrance && o.id !== entranceDoor);
  const entrance = openings.find((o) => o.id === entranceDoor);
  const plan = {
    meta: {
      name: M._meta?.name ?? 'Ev',
      demo: false,
      units: 'cm',
      importedFrom: sourceName,
      imported: new Date().toISOString().slice(0, 10),
      note: `Kaynak: ${
        M._meta?.source_legend
          ? Object.entries(M._meta.source_legend)
              .map(([k, v]) => `${k} = ${v}`)
              .join('; ')
          : String(M._meta?.measurement_sources ?? 'belirtilmedi').replace(/\.$/, '')
      }. Duvar kalınlığı ${T} cm varsayım.${open.length ? ` Ölçülmemiş bir alana açılan kapılar (${open.map((o) => o.name).join(', ')}) "giriş" sayıldı; o taraftaki geçiş henüz kontrol edilemiyor.` : ''}`,
      missing,
      notes,
      thinWalls: thin,
    },
    settings: {
      ceilingHeight: Math.max(...ceilings),
      eyeHeight: 160,
      passageMin: 75,
      passageHard: 60,
      accessMin: 60,
      gridStep: 2,
    },
    defaults: { wallThickness: T, doorHeight: 210 },
    ...(site ? { site } : {}),
    walls,
    openings,
    rooms,
    fixtures,
    access: {
      entranceDoor,
      elevator: null,
      note: entrance
        ? `Daire kapısı: ${entrance.name} (${entrance.width} cm). Asansör ölçülmedi.`
        : 'Daire giriş kapısı ve asansör ölçülmedi; teslimat kontrolü yalnızca oda kapılarıyla yapılıyor.',
    },
    splat: null,
  };

  return { plan, thin };
}
