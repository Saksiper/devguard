'use strict';

// Per-project, model-free read-resolver. Builds a token index from the project's
// OWN noted nodes (node_id + note text) and resolves a prompt to a node by rare-term
// overlap — free (~0ms), unlike the embedding resolver's ~680ms cold model load.
// It ONLY returns a node when confident: the top node must clear a floor AND beat
// the runner-up by a margin. Ambiguous/weak matches return null so the caller can
// defer to the embedding fallback rather than surface a vocabulary-neighbour's note
// (measured: two exam-question nodes both mentioning 'topic' tie at margin 1.0).

const STOP = new Set((
  'the a an of to in for on by and or is are be it its this that these those with as at from into ' +
  'new file implement return export function questions question answer answers based check iterate ' +
  'until correct after implementing verify behavior writing running string number array map label each ' +
  'there no not do so per any given side both may combine every returns null record when else which what ' +
  'you your they them then than has have was were will would should can could must also only just about ' +
  // Turkish function words — notes are written in the session language, so Turkish
  // prose needs the same treatment as English (measured live: 'yeni'/'için'/'bir'
  // alone drew false surfaces in a small index where every token has df=1).
  'için gibi kadar göre sonra önce şimdi ama ancak fakat çünkü yani ise değil daha çok pek hiç her hem ' +
  'ile bir iki onu bunu şunu ona buna şuna onun bunun şunun ben sen biz siz bana sana beni seni ' +
  'evet hayır tamam lütfen olan olarak oldu olur olsun var yok yeni şey yap yaz ' +
  'nasıl neden niye hangi nerede zaten belki galiba sadece yine ayrıca'
).split(/\s+/));

function tokens(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9çğıöşü]{3,}/g) || []).filter((t) => !STOP.has(t));
}

// Pure: build { nodes: Map<node_id, Set<token>>, df: {token: docFreq},
// nameTokens: Map<node_id, Set<token>> } from [{ node_id, text }]. Notes on the
// same node merge into one token set; nameTokens holds only the node-id-derived
// tokens (the feature's own name — higher-signal than note prose).
function buildIndex(docs) {
  const nodes = new Map();
  const nameTokens = new Map();
  for (const d of docs || []) {
    if (!d || !d.node_id) continue;
    const set = nodes.get(d.node_id) || new Set();
    for (const t of tokens(String(d.node_id).replace(/[/_-]/g, ' ') + ' ' + (d.text || ''))) set.add(t);
    nodes.set(d.node_id, set);
    if (!nameTokens.has(d.node_id)) {
      nameTokens.set(d.node_id, new Set(tokens(String(d.node_id).replace(/[/_-]/g, ' '))));
    }
  }
  const df = {};
  for (const set of nodes.values()) for (const t of set) df[t] = (df[t] || 0) + 1;
  return { nodes, df, nameTokens };
}

// Pure: score prompt tokens by summed rarity (1/df) per node, then gate on
// confidence. Returns node_id only when top >= floor AND runner-up/top < margin
// AND the evidence is real: at least 2 distinct matched tokens, OR a single match
// that NAMES the feature (node-id token). In a small index every token has df=1,
// so without the evidence gate ONE stray prose word cleared the floor (measured
// live: an unrelated prompt surfaced a note via a lone shared word).
function resolveIndex(index, promptText, marginThreshold = 0.75, floor = 0.3) {
  const pt = new Set(tokens(promptText));
  if (!index || !index.nodes || !index.nodes.size || !pt.size) return null;
  let topId = null, topScore = -1, secondScore = 0, topHits = 0, topNameHit = false;
  for (const [nodeId, set] of index.nodes) {
    let s = 0, hits = 0, nameHit = false;
    const names = index.nameTokens && index.nameTokens.get(nodeId);
    for (const t of pt) {
      if (!set.has(t)) continue;
      s += 1 / (index.df[t] || 1);
      hits += 1;
      if (names && names.has(t)) nameHit = true;
    }
    if (s > topScore) { secondScore = topScore; topScore = s; topId = nodeId; topHits = hits; topNameHit = nameHit; }
    else if (s > secondScore) { secondScore = s; }
  }
  if (topScore < floor) return null;                                  // weak signal
  if (topHits < 2 && !topNameHit) return null;                        // one stray prose word -> defer
  const margin = topScore > 0 ? secondScore / topScore : 1;
  if (margin >= marginThreshold) return null;                          // ambiguous -> defer
  return topId;
}

// DB-backed convenience for the UserPromptSubmit hook. Builds the index from the
// project's notes each call (all string ops; no model). Caller passes the margin.
function resolveByProjectIndex(db, promptText, marginThreshold = 0.75, floor = 0.3) {
  // Optional layer: any failure (e.g. a db without getNotes) returns null so
  // resolution falls through to the embedding layer rather than breaking.
  try {
    const notes = db.getNotes({ limit: 5000 });
    if (!notes || !notes.length) return null;
    // Head layers only: the surface SHOWS the head note, so relevance must be judged
    // against what would be shown. Superseded layers accumulate weeks of dead
    // vocabulary (measured live: bookkeeping tokens in dead layers drew surfaces
    // for prompts unrelated to the head).
    const heads = notes.filter((n) => n.superseded_by === null || n.superseded_by === undefined);
    if (!heads.length) return null;
    const index = buildIndex(heads.map((n) => ({ node_id: n.node_id, text: n.note_text })));
    return resolveIndex(index, promptText, marginThreshold, floor);
  } catch {
    return null;
  }
}

module.exports = { tokens, buildIndex, resolveIndex, resolveByProjectIndex };
