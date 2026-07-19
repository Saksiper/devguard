'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
let Database; try { Database = require('better-sqlite3'); } catch (_) { Database = null; }
const { sanitize } = require('./sanitize');
const { debugLog } = require('./debug-log');

let _db = null;

const MIGRATION_V1_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_path TEXT NOT NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);

CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  session_id TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  file TEXT NOT NULL,
  lines_start INTEGER,
  lines_end INTEGER,
  action TEXT,
  description TEXT,
  description_embedding BLOB,
  diff_text TEXT,
  diff_embedding BLOB,
  related_issue_id INTEGER,
  verdict TEXT,
  claude_verdict TEXT,
  verdict_quality INTEGER DEFAULT 1,
  FOREIGN KEY (related_issue_id) REFERENCES issues(id)
);
CREATE INDEX IF NOT EXISTS idx_changes_project ON changes(project_path);

CREATE TABLE IF NOT EXISTS issues (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  title TEXT,
  title_embedding BLOB,
  first_seen DATETIME,
  status TEXT,
  fix_change_id INTEGER,
  FOREIGN KEY (fix_change_id) REFERENCES changes(id)
);
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_path);

CREATE TABLE IF NOT EXISTS protected_zones (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  issue_id INTEGER NOT NULL,
  change_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  protected_commit TEXT,
  temp_lines_start INTEGER,
  temp_lines_end INTEGER,
  temp_protection INTEGER DEFAULT 1,
  reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (change_id) REFERENCES changes(id)
);
CREATE INDEX IF NOT EXISTS idx_protected_project ON protected_zones(project_path);

CREATE TABLE IF NOT EXISTS error_outputs (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  change_id INTEGER,
  error_string TEXT,
  error_hash TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (change_id) REFERENCES changes(id)
);
CREATE INDEX IF NOT EXISTS idx_errors_project ON error_outputs(project_path);

CREATE TABLE IF NOT EXISTS blame_cache (
  project_path TEXT NOT NULL,
  file_path TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  blame_data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_path, file_path, commit_hash)
);

CREATE VIRTUAL TABLE IF NOT EXISTS changes_fts USING fts5(
  description, diff_text, claude_verdict,
  content=changes, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS changes_ai AFTER INSERT ON changes BEGIN
  INSERT INTO changes_fts(rowid, description, diff_text, claude_verdict)
  VALUES (new.id, new.description, new.diff_text, new.claude_verdict);
END;

CREATE TRIGGER IF NOT EXISTS changes_ad AFTER DELETE ON changes BEGIN
  INSERT INTO changes_fts(changes_fts, rowid, description, diff_text, claude_verdict)
  VALUES ('delete', old.id, old.description, old.diff_text, old.claude_verdict);
END;

CREATE TRIGGER IF NOT EXISTS changes_au AFTER UPDATE ON changes BEGIN
  INSERT INTO changes_fts(changes_fts, rowid, description, diff_text, claude_verdict)
  VALUES ('delete', old.id, old.description, old.diff_text, old.claude_verdict);
  INSERT INTO changes_fts(rowid, description, diff_text, claude_verdict)
  VALUES (new.id, new.description, new.diff_text, new.claude_verdict);
END;
`;

const MIGRATION_V2_SQL = `
ALTER TABLE error_outputs ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_errors_session ON error_outputs(project_path, session_id);
`;

const MIGRATION_V3_SQL = `
ALTER TABLE sessions ADD COLUMN pending_summary TEXT;

CREATE TABLE IF NOT EXISTS rejection_ledger (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  session_id TEXT,
  file TEXT NOT NULL,
  middleware_id TEXT,
  block_message TEXT,
  rejected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  resumed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_rejection_project ON rejection_ledger(project_path, session_id);
CREATE INDEX IF NOT EXISTS idx_rejection_file ON rejection_ledger(project_path, file, session_id);
`;
// NOTE: V3 historical schema retained for migration replay correctness.
// V11 drops rejection_ledger after block-feature removal (2026-05-20).

const MIGRATION_V4_SQL = `
ALTER TABLE sessions ADD COLUMN last_injection_change_id INTEGER DEFAULT 0;
`;

const MIGRATION_V5_SQL = `
CREATE TABLE IF NOT EXISTS detection_log (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  session_id TEXT,
  file TEXT NOT NULL,
  middleware_id TEXT,
  decision TEXT NOT NULL,
  level INTEGER,
  type TEXT,
  confidence REAL,
  message TEXT,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  classification TEXT,
  classified_at DATETIME,
  classification_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_detection_log_session ON detection_log(project_path, session_id);
`;

const MIGRATION_V6_SQL = `
ALTER TABLE error_outputs ADD COLUMN test_framework TEXT;
ALTER TABLE error_outputs ADD COLUMN test_name TEXT;
`;

const MIGRATION_V7_SQL = `
CREATE TABLE IF NOT EXISTS threshold_params (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  alpha REAL DEFAULT 1.0,
  beta REAL DEFAULT 1.0,
  sample_count INTEGER DEFAULT 0,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_path, category, subcategory)
);
CREATE INDEX IF NOT EXISTS idx_threshold_project ON threshold_params(project_path);
`;

const MIGRATION_V8_SQL = `
ALTER TABLE detection_log ADD COLUMN next_change_id INTEGER;
ALTER TABLE detection_log ADD COLUMN next_change_same_file INTEGER;
ALTER TABLE detection_log ADD COLUMN next_change_seconds INTEGER;
`;

const MIGRATION_V9_SQL = `
ALTER TABLE detection_log ADD COLUMN next_change_verdict TEXT;
`;

const MIGRATION_V10_SQL = `
ALTER TABLE detection_log RENAME COLUMN next_change_verdict TO next_change_reasoning;
ALTER TABLE detection_log ADD COLUMN next_change_outcome TEXT;
`;

const MIGRATION_V11_SQL = `
DROP INDEX IF EXISTS idx_rejection_project;
DROP INDEX IF EXISTS idx_rejection_file;
DROP TABLE IF EXISTS rejection_ledger;
`;

// V12: protect_note column on changes — heuristic "don't touch" warning that
// post-edit hook fills at capture time. Nullable; existing rows stay null.
// See src/engine/protect-heuristic.js for generator.
const MIGRATION_V12_SQL = `
ALTER TABLE changes ADD COLUMN protect_note TEXT;
`;

// V13: notes + note_events tables — track the *effect* of notes (which note
// was surfaced to Claude, what tag Claude produced afterwards, whether the
// note proved useful). Producers (yol1-4) are out of scope here; this only
// builds the data depot.
const MIGRATION_V13_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  session_id TEXT,
  related_change_id INTEGER,
  file TEXT NOT NULL,
  lines_start INTEGER,
  lines_end INTEGER,
  node_id TEXT,
  source TEXT NOT NULL,
  confidence_level INTEGER NOT NULL,
  note_text TEXT NOT NULL,
  trigger_data TEXT,
  superseded_by INTEGER,
  dismissed_at DATETIME,
  dismissed_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notes_project_file ON notes(project_path, file);
CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(project_path, source);
CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(project_path, session_id);

CREATE TABLE IF NOT EXISTS note_events (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  note_id INTEGER NOT NULL,
  session_id TEXT,
  change_id INTEGER,
  event_type TEXT NOT NULL,
  payload TEXT,
  cost_tokens INTEGER,
  cost_ms INTEGER,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_note_events_note ON note_events(project_path, note_id);
CREATE INDEX IF NOT EXISTS idx_note_events_type ON note_events(project_path, event_type);
CREATE INDEX IF NOT EXISTS idx_note_events_session ON note_events(project_path, session_id);
`;

// V14: transcript-backfill provenance + cursor. tool_use_id/source tag each
// change with where it came from (live hook vs replayed transcript). The partial
// unique index makes backfill idempotent: a duplicate (project_path, tool_use_id)
// INSERT throws SQLITE_CONSTRAINT_UNIQUE so the backfill engine can skip rows it
// already imported. backfill_cursor tracks how far each transcript was read.
const MIGRATION_V14_SQL = `
ALTER TABLE changes ADD COLUMN tool_use_id TEXT;
ALTER TABLE changes ADD COLUMN source TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_changes_tooluse ON changes(project_path, tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS backfill_cursor (
  transcript_path TEXT PRIMARY KEY,
  last_size INTEGER NOT NULL DEFAULT 0,
  last_processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// V15: features table + changes.node_id — every change gets a semantic node_id
// ("continent/country") at write-time. features clusters same-feature changes via
// nearest-centroid on the post-edit embedding. UNIQUE(project_path, node_id): the
// same node_id (e.g. "security/auth") must be able to coexist across projects, so
// node_id alone is NOT unique (roadmap's "node_id UNIQUE" is wrong for multi-tenancy).
// NEVER touch the changes CREATE TABLE (fresh-DB duplicate-column trap) — node_id is
// added by ALTER only.
const MIGRATION_V15_SQL = `
CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY,
  project_path TEXT NOT NULL,
  continent TEXT NOT NULL,
  country TEXT NOT NULL,
  node_id TEXT NOT NULL,
  centroid_embedding BLOB,
  member_count INTEGER NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_path, node_id)
);
CREATE INDEX IF NOT EXISTS idx_features_project ON features(project_path);
CREATE INDEX IF NOT EXISTS idx_features_continent ON features(project_path, continent);
ALTER TABLE changes ADD COLUMN node_id TEXT;
CREATE INDEX IF NOT EXISTS idx_changes_node ON changes(project_path, node_id);
`;

// notes staleness (V16): remember the real source file a note concerns plus a
// content fingerprint captured at write time, so the surface path can flag a note
// as stale when the file changed since. notes.file holds the node_id for sphere
// notes, so the real path needs its own column. ALTER only — never touch CREATE.
const MIGRATION_V16_SQL = `
ALTER TABLE notes ADD COLUMN source_file TEXT;
ALTER TABLE notes ADD COLUMN code_fingerprint TEXT;
`;

// Legacy backfill wrote raw ISO-8601 (with T/Z) into changes.timestamp while live
// hooks wrote CURRENT_TIMESTAMP format — mixed formats break string MAX/ORDER BY.
// One-off normalize; insertChange now normalizes at insert time.
const MIGRATION_V17_SQL = `
UPDATE changes SET timestamp = datetime(timestamp)
WHERE timestamp LIKE '%T%' AND datetime(timestamp) IS NOT NULL;
`;

const MIGRATIONS = [
  { version: 1, name: 'initial_schema', sql: MIGRATION_V1_SQL },
  { version: 2, name: 'error_outputs_session_id', sql: MIGRATION_V2_SQL },
  { version: 3, name: 'sprint3_protection_system', sql: MIGRATION_V3_SQL },
  { version: 4, name: 'periodic_injection', sql: MIGRATION_V4_SQL },
  { version: 5, name: 'detection_log', sql: MIGRATION_V5_SQL },
  { version: 6, name: 'test_integration', sql: MIGRATION_V6_SQL },
  { version: 7, name: 'adaptive_threshold', sql: MIGRATION_V7_SQL },
  { version: 8, name: 'context_effectiveness', sql: MIGRATION_V8_SQL },
  { version: 9, name: 'detection_verdict_tracking', sql: MIGRATION_V9_SQL },
  { version: 10, name: 'verdict_to_reasoning_with_outcome', sql: MIGRATION_V10_SQL },
  { version: 11, name: 'drop_rejection_ledger', sql: MIGRATION_V11_SQL },
  { version: 12, name: 'changes_protect_note', sql: MIGRATION_V12_SQL },
  { version: 13, name: 'notes_and_events_tables', sql: MIGRATION_V13_SQL },
  { version: 14, name: 'backfill_provenance_and_cursor', sql: MIGRATION_V14_SQL },
  { version: 15, name: 'features_and_change_node_id', sql: MIGRATION_V15_SQL },
  { version: 16, name: 'notes_source_fingerprint', sql: MIGRATION_V16_SQL },
  { version: 17, name: 'normalize_change_timestamps', sql: MIGRATION_V17_SQL },
];

// CLI/manual runs lack CLAUDE_PLUGIN_DATA; without this scan they'd read/write
// a near-empty ~/.devguard DB while the real data lives in the plugin data dir.
// Selection is DETERMINISTIC, not newest-mtime: two DBs can coexist (the canonical
// marketplace install and Desktop's '-inline' DB, or a pre-merge '-inline-*'
// rename), and picking by mtime made the CLI flip between them day to day, so data
// scattered across both files. The canonical marketplace dir always wins over any
// inline variant; backup dirs are never eligible.
function findNewestPluginDb(baseDir) {
  try {
    const candidates = [];
    for (const entry of fs.readdirSync(baseDir)) {
      if (/^backup/i.test(entry)) continue; // a backup dir is never the live DB
      const candidate = path.join(baseDir, entry, 'devguard.db');
      try {
        const mtime = fs.statSync(candidate).mtimeMs;
        candidates.push({ path: candidate, mtime, name: entry });
      } catch { /* no devguard.db in this plugin dir */ }
    }
    if (candidates.length === 0) return null;
    // Prefer canonical (non-inline) dirs; fall back to the full set only if none
    // exist. Within the chosen pool, newest mtime is the last-resort tie-break.
    const canonical = candidates.filter(c => !/inline/i.test(c.name));
    const pool = canonical.length > 0 ? canonical : candidates;
    pool.sort((a, b) => b.mtime - a.mtime);
    const chosen = pool[0];
    if (candidates.length > 1) {
      debugLog('db', 'Multiple plugin-data DBs; deterministic selection', {
        chosen: chosen.path, canonical: canonical.length, total: candidates.length,
      });
    }
    return chosen.path;
  } catch {
    return null;
  }
}

function getDbPath() {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return path.join(pluginData, 'devguard.db');
  const pluginsBase = process.env.DEVGUARD_PLUGINS_DIR
    || path.join(os.homedir(), '.claude', 'plugins', 'data');
  const found = findNewestPluginDb(pluginsBase);
  if (found) {
    debugLog('db', 'CLAUDE_PLUGIN_DATA not set, using newest plugin data DB', { path: found });
    return found;
  }
  const fallback = path.join(os.homedir(), '.devguard');
  if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
  debugLog('db', 'CLAUDE_PLUGIN_DATA not set, using fallback', { path: fallback });
  return path.join(fallback, 'devguard.db');
}

function openDb() {
  if (!Database) throw new Error('better-sqlite3 unavailable');
  if (_db) return _db;
  const dbPath = getDbPath();
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const handle = new Database(dbPath);
  try {
    handle.pragma('journal_mode = WAL');
    handle.pragma('foreign_keys = ON');
    // Concurrent sessions (or hook + backfill) share this file: wait for the
    // writer instead of throwing SQLITE_BUSY into the hook.
    handle.pragma('busy_timeout = 5000');
    runMigrations(handle);
  } catch (err) {
    // Never publish a half-initialized handle: a later openDb() must retry from
    // scratch, not reuse a connection whose migrations failed.
    try { handle.close(); } catch { /* already broken */ }
    throw err;
  }
  _db = handle;
  debugLog('db', 'Database opened', { path: dbPath });
  return _db;
}

function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  const applied = db.prepare('SELECT version FROM _migrations').all().map(r => r.version);

  for (const migration of MIGRATIONS) {
    if (applied.includes(migration.version)) continue;
    // Wrap the schema change + bookkeeping row in ONE transaction: if the process
    // dies mid-migration, the partial DDL rolls back and the migration re-applies
    // cleanly next open. Otherwise a committed ALTER with no _migrations row re-execs
    // the ALTER and throws "duplicate column", bricking DB open (every hook then fails).
    db.transaction(() => {
      // Re-check inside the write lock: a concurrent first-open may have applied
      // this migration between the `applied` read above and this transaction —
      // re-running its ALTERs would throw "duplicate column" and crash the hook.
      const done = db.prepare('SELECT 1 FROM _migrations WHERE version = ?').get(migration.version);
      if (done) return;
      db.exec(migration.sql);
      db.prepare('INSERT INTO _migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
    }).immediate();
    debugLog('db', 'Migration applied', { version: migration.version, name: migration.name });
  }
}

// Outcome classification from Claude's reasoning at next-change time.
// Looks for explicit [DG-XXX] tag in the reasoning preamble (template introduced
// after audit showed Claude rarely produced parseable acknowledgments naturally).
// Categories:
//   dg_continue   — Claude tagged [DG-CONTINUE]: explicit "I'll proceed with this approach"
//   dg_pivot      — Claude tagged [DG-PIVOT]: explicit "I'll try a different approach"
//   dg_pause      — Claude tagged [DG-PAUSE]: explicit "I need to investigate first"
//   dg_none       — Claude did not produce a tag (instruction ignored or message lost)
//   no_reasoning  — transcript parser returned nothing
// Tags may echo the surfaced node ([DG-CONTINUE ui_ux/filter]); the echo part is
// optional but must start with whitespace so look-alikes ([DG-CONTINUED]) don't
// match, and must stay on ONE line ([^\]\n]) so a stray '[DG-CONTINUE' quote in a
// multi-line verdict can't reach a ']' lines later and fake an acknowledgment.
const DG_TAG_PATTERNS = {
  dg_continue: /\[DG-CONTINUE(?:\s[^\]\n]*)?\]/i,
  dg_pivot: /\[DG-PIVOT(?:\s[^\]\n]*)?\]/i,
  dg_pause: /\[DG-PAUSE(?:\s[^\]\n]*)?\]/i,
};

function classifyOutcome(reasoning, _sameFile) {
  if (!reasoning) return 'no_reasoning';
  if (DG_TAG_PATTERNS.dg_pivot.test(reasoning)) return 'dg_pivot';
  if (DG_TAG_PATTERNS.dg_pause.test(reasoning)) return 'dg_pause';
  if (DG_TAG_PATTERNS.dg_continue.test(reasoning)) return 'dg_continue';
  return 'dg_none';
}

// Shared by ackNoteCompliance/finalizeNoteCompliance: every note 'surfaced' in the
// session with no compliance event yet. A note counts as tracked once ANY compliance
// event exists for it in this session, so the two writers can never double-emit.
const UNTRACKED_SURFACED_SQL = `
  SELECT DISTINCT ne.note_id, n.node_id, n.source_file
  FROM note_events ne
  JOIN notes n ON n.id = ne.note_id AND n.project_path = ne.project_path
  WHERE ne.project_path = ? AND ne.session_id = ? AND ne.event_type = 'surfaced'
    AND ne.note_id NOT IN (
      SELECT note_id FROM note_events
      WHERE project_path = ? AND session_id = ? AND event_type IN ('complied', 'ignored', 'superseded', 'lapsed')
    )`;

// Escapes SQL LIKE wildcards (% _ \) so a user-supplied prefix is matched
// literally — node_id values commonly contain underscores (e.g. "ui_ux/filter").
function escapeLike(str) {
  return str.replace(/[\\%_]/g, ch => '\\' + ch);
}

function getDb(projectPath) {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('getDb requires a non-empty projectPath string');
  }
  const db = openDb();
  const pp = projectPath.replace(/\\/g, '/');

  return {
    // --- changes ---
    insertChange(data) {
      debugLog('db', 'insertChange', { project: pp, file: data.file });
      // Plain INSERT (not OR IGNORE): a duplicate (project_path, tool_use_id) must
      // throw SQLITE_CONSTRAINT_UNIQUE so the backfill engine can detect already
      // imported rows; we also do not want to silently swallow NOT NULL violations.
      // timestamp is normalized HERE (datetime()) — the single canonical point;
      // backfill passes raw ISO-8601 from transcripts, which would otherwise sort
      // wrong against CURRENT_TIMESTAMP rows. Unparseable input falls back to now.
      const stmt = db.prepare(`INSERT INTO changes
        (project_path, session_id, file, lines_start, lines_end, action, description,
         description_embedding, diff_text, diff_embedding, related_issue_id, verdict,
         claude_verdict, verdict_quality, protect_note, tool_use_id, source, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), CURRENT_TIMESTAMP))`);
      const info = stmt.run(
        pp,
        data.session_id || null,
        data.file,
        data.lines_start ?? null,
        data.lines_end ?? null,
        data.action || null,
        sanitize(data.description) || null,
        data.description_embedding || null,
        sanitize(data.diff_text) || null,
        data.diff_embedding || null,
        data.related_issue_id ?? null,
        sanitize(data.verdict) || null,
        sanitize(data.claude_verdict) || null,
        data.verdict_quality ?? 1,
        sanitize(data.protect_note) || null,
        sanitize(data.tool_use_id) || null,
        sanitize(data.source) || null,
        data.timestamp || null,
      );
      return info.lastInsertRowid;
    },

    getChanges(opts = {}) {
      debugLog('db', 'getChanges', { project: pp });
      let sql = 'SELECT * FROM changes WHERE project_path = ?';
      const params = [pp];
      if (opts.session_id) {
        sql += ' AND session_id = ?';
        params.push(opts.session_id);
      }
      if (opts.file) {
        sql += ' AND file = ?';
        params.push(opts.file);
      }
      sql += ' ORDER BY timestamp DESC, id DESC';
      if (opts.limit) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }
      return db.prepare(sql).all(...params);
    },

    getChangeCount() {
      return db.prepare('SELECT COUNT(*) as cnt FROM changes WHERE project_path = ?').get(pp).cnt;
    },

    getChangeByToolUseId(toolUseId) {
      return db.prepare(
        'SELECT * FROM changes WHERE project_path = ? AND tool_use_id = ?'
      ).get(pp, toolUseId) || null;
    },

    updateChangeEmbedding(changeId, embedding) {
      debugLog('db', 'updateChangeEmbedding', { project: pp, changeId });
      return db.prepare(
        'UPDATE changes SET description_embedding = ? WHERE id = ? AND project_path = ?'
      ).run(embedding, changeId, pp).changes;
    },

    // Mirror of updateChangeEmbedding — set the semantic node_id after insert.
    // node_id is written UNCONDITIONALLY (even when embeddings are disabled), so the
    // hook computes it separately and patches the row here rather than at insert time.
    updateChangeNodeId(changeId, nodeId) {
      debugLog('db', 'updateChangeNodeId', { project: pp, changeId, nodeId });
      return db.prepare(
        'UPDATE changes SET node_id = ? WHERE id = ? AND project_path = ?'
      ).run(sanitize(nodeId), changeId, pp).changes;
    },

    // Retrospective verdict write (S4.1): the reply to an edit lands in the transcript
    // AFTER PostToolUse fires, so its claude_verdict is patched in on a later post-edit
    // once the DG-tag reply exists. Verdict is captured -> quality bumps to 3.
    updateChangeVerdict(changeId, claudeVerdict, verdictQuality) {
      debugLog('db', 'updateChangeVerdict', { project: pp, changeId });
      return db.prepare(
        'UPDATE changes SET claude_verdict = ?, verdict_quality = ? WHERE id = ? AND project_path = ?'
      ).run(sanitize(claudeVerdict) || null, verdictQuality ?? 3, changeId, pp).changes;
    },

    getRecentEmbeddings(sessionId, limit) {
      debugLog('db', 'getRecentEmbeddings', { project: pp, sessionId, limit });
      return db.prepare(`
        SELECT id, file, description_embedding, timestamp
        FROM changes
        WHERE project_path = ? AND session_id = ?
          AND description_embedding IS NOT NULL
        ORDER BY timestamp DESC, id DESC
        LIMIT ?
      `).all(pp, sessionId, limit);
    },

    // --- issues ---
    insertIssue(data) {
      debugLog('db', 'insertIssue', { project: pp, title: data.title });
      const stmt = db.prepare(`INSERT INTO issues
        (project_path, title, title_embedding, first_seen, status, fix_change_id)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const info = stmt.run(
        pp,
        sanitize(data.title) || null,
        data.title_embedding || null,
        data.first_seen || new Date().toISOString(),
        data.status || 'open',
        data.fix_change_id ?? null,
      );
      return info.lastInsertRowid;
    },

    getLastOpenIssueId() {
      const row = db.prepare(
        'SELECT id FROM issues WHERE project_path = ? AND status = ? ORDER BY id DESC LIMIT 1'
      ).get(pp, 'open');
      return row ? row.id : null;
    },

    getIssues(opts = {}) {
      debugLog('db', 'getIssues', { project: pp });
      let sql = 'SELECT * FROM issues WHERE project_path = ?';
      const params = [pp];
      if (opts.status) {
        sql += ' AND status = ?';
        params.push(opts.status);
      }
      return db.prepare(sql).all(...params);
    },

    // --- error_outputs ---
    insertErrorOutput(data) {
      debugLog('db', 'insertErrorOutput', { project: pp, test_framework: data.test_framework || null });
      const stmt = db.prepare(`INSERT INTO error_outputs
        (project_path, change_id, error_string, error_hash, session_id, test_framework, test_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const info = stmt.run(
        pp,
        data.change_id ?? null,
        sanitize(data.error_string) || null,
        data.error_hash || null,
        data.session_id || null,
        sanitize(data.test_framework) || null,
        sanitize(data.test_name) || null,
      );
      return info.lastInsertRowid;
    },

    getErrorOutputs(opts = {}) {
      debugLog('db', 'getErrorOutputs', { project: pp });
      let sql = 'SELECT * FROM error_outputs WHERE project_path = ?';
      const params = [pp];
      if (opts.session_id) {
        sql += ' AND session_id = ?';
        params.push(opts.session_id);
      }
      if (opts.error_hash) {
        sql += ' AND error_hash = ?';
        params.push(opts.error_hash);
      }
      sql += ' ORDER BY timestamp DESC, id DESC';
      if (opts.limit) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }
      return db.prepare(sql).all(...params);
    },

    // --- sessions ---
    insertSession(sessionId) {
      debugLog('db', 'insertSession', { project: pp, sessionId });
      const stmt = db.prepare('INSERT INTO sessions (session_id, project_path) VALUES (?, ?)');
      return stmt.run(sessionId, pp).lastInsertRowid;
    },

    getLatestSession() {
      return db.prepare(
        'SELECT * FROM sessions WHERE project_path = ? ORDER BY id DESC LIMIT 1'
      ).get(pp) || null;
    },

    getSessionById(sessionId) {
      return db.prepare(
        'SELECT * FROM sessions WHERE project_path = ? AND session_id = ?'
      ).get(pp, sessionId) || null;
    },

    getSessionCount() {
      return db.prepare('SELECT COUNT(*) as cnt FROM sessions WHERE project_path = ?').get(pp).cnt;
    },

    setPendingSummary(sessionId, content) {
      debugLog('db', 'setPendingSummary', { project: pp, sessionId });
      return db.prepare(
        'UPDATE sessions SET pending_summary = ? WHERE session_id = ? AND project_path = ?'
      ).run(content, sessionId, pp).changes;
    },

    consumePendingSummary(sessionId) {
      const row = db.prepare(
        'SELECT pending_summary FROM sessions WHERE session_id = ? AND project_path = ? AND pending_summary IS NOT NULL'
      ).get(sessionId, pp);
      if (!row || !row.pending_summary) return null;
      db.prepare(
        'UPDATE sessions SET pending_summary = NULL WHERE session_id = ? AND project_path = ?'
      ).run(sessionId, pp);
      return row.pending_summary;
    },

    getChangeCountSince(sessionId, sinceId) {
      return db.prepare(
        'SELECT COUNT(*) as cnt FROM changes WHERE project_path = ? AND session_id = ? AND id > ?'
      ).get(pp, sessionId, sinceId).cnt;
    },

    getMaxChangeId(sessionId) {
      const row = db.prepare(
        'SELECT MAX(id) as max_id FROM changes WHERE project_path = ? AND session_id = ?'
      ).get(pp, sessionId);
      return row ? (row.max_id || 0) : 0;
    },

    updateLastInjectionChangeId(sessionId, changeId) {
      debugLog('db', 'updateLastInjectionChangeId', { project: pp, sessionId, changeId });
      return db.prepare(
        'UPDATE sessions SET last_injection_change_id = ? WHERE session_id = ? AND project_path = ?'
      ).run(changeId, sessionId, pp).changes;
    },

    // --- protected_zones ---
    insertProtectedZone(data) {
      debugLog('db', 'insertProtectedZone', { project: pp, file: data.file });
      const stmt = db.prepare(`INSERT INTO protected_zones
        (project_path, issue_id, change_id, file, protected_commit,
         temp_lines_start, temp_lines_end, temp_protection, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const info = stmt.run(
        pp,
        data.issue_id,
        data.change_id,
        data.file,
        data.protected_commit || null,
        data.temp_lines_start ?? null,
        data.temp_lines_end ?? null,
        data.temp_protection ?? 1,
        sanitize(data.reason) || null,
      );
      return info.lastInsertRowid;
    },

    getProtectedZones(opts = {}) {
      debugLog('db', 'getProtectedZones', { project: pp });
      let sql = 'SELECT * FROM protected_zones WHERE project_path = ?';
      const params = [pp];
      if (opts.file) {
        sql += ' AND file = ?';
        params.push(opts.file);
      }
      return db.prepare(sql).all(...params);
    },

    hasProtectedFile(file) {
      const row = db.prepare(
        'SELECT 1 FROM protected_zones WHERE project_path = ? AND file = ? LIMIT 1'
      ).get(pp, file);
      return !!row;
    },

    getProtectedCommitsForFile(file) {
      return db.prepare(
        'SELECT DISTINCT protected_commit FROM protected_zones WHERE project_path = ? AND file = ? AND protected_commit IS NOT NULL'
      ).all(pp, file).map(r => r.protected_commit);
    },

    getTempProtectionsForFile(file) {
      return db.prepare(
        'SELECT * FROM protected_zones WHERE project_path = ? AND file = ? AND temp_protection = 1'
      ).all(pp, file);
    },

    promoteProtection(commitHash, files) {
      debugLog('db', 'promoteProtection', { project: pp, commitHash, fileCount: files.length });
      if (!files || files.length === 0) return 0;
      const placeholders = files.map(() => '?').join(',');
      return db.prepare(
        `UPDATE protected_zones SET protected_commit = ?, temp_protection = 0 WHERE project_path = ? AND file IN (${placeholders}) AND temp_protection = 1`
      ).run(commitHash, pp, ...files).changes;
    },

    updateIssueFixChange(issueId, changeId) {
      debugLog('db', 'updateIssueFixChange', { project: pp, issueId, changeId });
      return db.prepare(
        'UPDATE issues SET fix_change_id = ? WHERE id = ? AND project_path = ?'
      ).run(changeId, issueId, pp).changes;
    },

    // --- detection_log (dogfood) ---
    insertDetection(data) {
      debugLog('db', 'insertDetection', { project: pp, file: data.file, decision: data.decision });
      const stmt = db.prepare(`INSERT INTO detection_log
        (project_path, session_id, file, middleware_id, decision, level, type, confidence, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      return stmt.run(
        pp,
        data.session_id || null,
        sanitize(data.file) || data.file,
        data.middleware_id || null,
        data.decision,
        data.level ?? null,
        data.type || null,
        data.confidence ?? null,
        sanitize(data.message) || null,
      ).lastInsertRowid;
    },

    getDetections(opts = {}) {
      debugLog('db', 'getDetections', { project: pp });
      let sql = 'SELECT * FROM detection_log WHERE project_path = ?';
      const params = [pp];
      if (opts.session_id) {
        sql += ' AND session_id = ?';
        params.push(opts.session_id);
      }
      if (opts.unclassified) {
        sql += ' AND classification IS NULL';
      }
      sql += ' ORDER BY detected_at DESC, id DESC';
      if (opts.limit) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }
      return db.prepare(sql).all(...params);
    },

    classifyDetection(id, classification, note) {
      debugLog('db', 'classifyDetection', { project: pp, id, classification });
      return db.prepare(
        `UPDATE detection_log SET classification = ?, classified_at = datetime('now'), classification_note = ?
         WHERE id = ? AND project_path = ?`
      ).run(classification, note || null, id, pp).changes;
    },

    getDetectionStats(opts = {}) {
      debugLog('db', 'getDetectionStats', { project: pp });
      let where = 'WHERE project_path = ?';
      const params = [pp];
      if (opts.session_id) {
        where += ' AND session_id = ?';
        params.push(opts.session_id);
      }
      const rows = db.prepare(
        `SELECT classification, COUNT(*) as cnt FROM detection_log ${where} GROUP BY classification`
      ).all(...params);
      const counts = { tp: 0, fp: 0, fn: 0, unclassified: 0 };
      let total = 0;
      for (const row of rows) {
        total += row.cnt;
        if (row.classification === 'tp') counts.tp = row.cnt;
        else if (row.classification === 'fp') counts.fp = row.cnt;
        else if (row.classification === 'fn') counts.fn = row.cnt;
        else counts.unclassified += row.cnt;
      }
      return { total, ...counts };
    },

    getRecentDetectionMessages(sessionId, limit = 3) {
      debugLog('db', 'getRecentDetectionMessages', { project: pp, sessionId });
      return db.prepare(
        `SELECT message FROM detection_log WHERE project_path = ? AND session_id = ?
         ORDER BY detected_at DESC, id DESC LIMIT ?`
      ).all(pp, sessionId, limit).map(r => r.message);
    },

    getDetectionOutcomes(opts = {}) {
      debugLog('db', 'getDetectionOutcomes', { project: pp });
      let sql = `SELECT id, session_id, file, middleware_id, decision, message, detected_at,
         next_change_same_file, next_change_seconds, next_change_reasoning, next_change_outcome
         FROM detection_log WHERE project_path = ? AND next_change_id IS NOT NULL`;
      const params = [pp];
      if (opts.session_id) {
        sql += ' AND session_id = ?';
        params.push(opts.session_id);
      }
      if (opts.has_reasoning) {
        sql += ' AND next_change_reasoning IS NOT NULL';
      }
      if (opts.outcome) {
        sql += ' AND next_change_outcome = ?';
        params.push(opts.outcome);
      }
      sql += ' ORDER BY detected_at DESC';
      if (opts.limit) {
        sql += ' LIMIT ?';
        params.push(opts.limit);
      }
      return db.prepare(sql).all(...params);
    },

    // S4.1 fix — detection-linking is DECOUPLED from outcome-labeling. linkDetectionsToChange
    // links THIS edit's still-unlinked detections to the change at INSERT time (1:1, temporal),
    // leaving outcome/reasoning NULL. labelDetectionOutcome fills those in retrospectively once
    // the DG-tag reply exists. The old single-shot trackDetectionOutcome greedily linked the 5
    // most-recent unlinked detections to whatever change it was called with — at post-edit for
    // edit N that scooped edit N's own (still-unlinked) detection onto the PRIOR change C_{N-1}
    // (off-by-one). Splitting the two phases keeps each detection linked to its own change.
    linkDetectionsToChange(sessionId, changeId, changeFile) {
      const untracked = db.prepare(
        `SELECT id, file, detected_at FROM detection_log
         WHERE project_path = ? AND session_id = ? AND next_change_id IS NULL
           AND decision IN ('warn', 'block') -- 'block' = pre-a43ba41 legacy rows (still live in DBs); do not drop
         ORDER BY id DESC LIMIT 5`
      ).all(pp, sessionId);
      if (untracked.length === 0) return 0;

      let updated = 0;
      for (const det of untracked) {
        const sameFile = det.file === changeFile ? 1 : 0;
        let seconds = null;
        try {
          const now = new Date();
          const then = new Date(det.detected_at + 'Z');
          seconds = Math.round((now - then) / 1000);
          if (isNaN(seconds) || seconds < 0) seconds = null;
        } catch { /* non-fatal */ }

        db.prepare(
          `UPDATE detection_log SET next_change_id = ?, next_change_same_file = ?, next_change_seconds = ?
           WHERE id = ? AND project_path = ?`
        ).run(changeId, sameFile, seconds, det.id, pp);
        updated++;
      }
      debugLog('db', 'linkDetectionsToChange', { project: pp, sessionId, updated, changeFile });
      return updated;
    },

    labelDetectionOutcome(sessionId, changeId, reasoning) {
      const linked = db.prepare(
        `SELECT id, next_change_same_file FROM detection_log
         WHERE project_path = ? AND next_change_id = ? AND next_change_outcome IS NULL`
      ).all(pp, changeId);
      if (linked.length === 0) return 0;

      let updated = 0;
      for (const det of linked) {
        const outcome = classifyOutcome(reasoning, det.next_change_same_file === 1);
        db.prepare(
          `UPDATE detection_log SET next_change_outcome = ?, next_change_reasoning = ?
           WHERE id = ? AND project_path = ?`
        ).run(outcome, sanitize(reasoning) || null, det.id, pp);
        updated++;
      }
      debugLog('db', 'labelDetectionOutcome', { project: pp, sessionId, changeId, updated, hasReasoning: !!reasoning });
      return updated;
    },

    // Backward-compatible wrapper: link then label in one shot. Net effect on
    // detection_log rows is identical to the old single-method behavior — including
    // reasoning === null, which the old code labeled 'no_reasoning' via classifyOutcome.
    // (The label call is unconditional, not guarded on reasoning, precisely to preserve
    // that null -> 'no_reasoning' path that detection-log.test.js asserts.)
    trackDetectionOutcome(sessionId, changeId, changeFile, reasoning) {
      const n = this.linkDetectionsToChange(sessionId, changeId, changeFile);
      this.labelDetectionOutcome(sessionId, changeId, reasoning);
      return n;
    },

    // Cooldown check: same (file, middleware) warned within last N change events?
    // Returns true if suppress (detection within cooldown window), false if OK to fire.
    hasRecentDetectionForFile(sessionId, file, middlewareId, withinLastN) {
      if (!sessionId || !file || !middlewareId || !withinLastN || withinLastN <= 0) {
        return false;
      }
      const det = db.prepare(
        `SELECT detected_at FROM detection_log
         WHERE project_path = ? AND session_id = ? AND file = ? AND middleware_id = ?
           AND decision IN ('warn', 'block') -- 'block' = pre-a43ba41 legacy rows (still live in DBs); do not drop
         ORDER BY id DESC LIMIT 1`
      ).get(pp, sessionId, file, middlewareId);
      if (!det) return false;

      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM changes
         WHERE project_path = ? AND session_id = ? AND timestamp > ?`
      ).get(pp, sessionId, det.detected_at);
      const changesSince = row ? (row.cnt || 0) : 0;

      return changesSince < withinLastN;
    },

    insertFalseNegative(data) {
      debugLog('db', 'insertFalseNegative', { project: pp });
      const stmt = db.prepare(`INSERT INTO detection_log
        (project_path, session_id, file, decision, classification, classified_at, classification_note)
        VALUES (?, ?, ?, 'fn', 'fn', datetime('now'), ?)`);
      return stmt.run(
        pp,
        data.session_id || null,
        data.file || 'unknown',
        data.note || null,
      ).lastInsertRowid;
    },

    // --- notes + note_events (effect tracking depot, V13) ---
    // Producers (yol1-4) write notes; consumers (pre-edit surface, post-edit
    // outcome) log events. This is the *depot only* — no producer/consumer
    // wiring lives here. See plans/rippling-forging-whale.md for design.
    insertNote(data) {
      debugLog('db', 'insertNote', { project: pp, file: data.file, source: data.source });
      const stmt = db.prepare(`INSERT INTO notes
        (project_path, session_id, related_change_id, file, lines_start, lines_end,
         node_id, source, confidence_level, note_text, trigger_data,
         source_file, code_fingerprint)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      return stmt.run(
        pp,
        data.session_id || null,
        data.related_change_id ?? null,
        data.file,
        data.lines_start ?? null,
        data.lines_end ?? null,
        sanitize(data.node_id) || null,
        data.source,
        data.confidence_level,
        sanitize(data.note_text),
        data.trigger_data ? sanitize(JSON.stringify(data.trigger_data)) : null,
        data.source_file ?? null,
        data.code_fingerprint ?? null,
      ).lastInsertRowid;
    },

    insertNoteEvent(data) {
      debugLog('db', 'insertNoteEvent', { project: pp, note_id: data.note_id, event_type: data.event_type });
      const stmt = db.prepare(`INSERT INTO note_events
        (project_path, note_id, session_id, change_id, event_type, payload, cost_tokens, cost_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      return stmt.run(
        pp,
        data.note_id,
        data.session_id || null,
        data.change_id ?? null,
        data.event_type,
        data.payload ? sanitize(JSON.stringify(data.payload)) : null,
        data.cost_tokens ?? null,
        data.cost_ms ?? null,
      ).lastInsertRowid;
    },

    getNotes(opts = {}) {
      debugLog('db', 'getNotes', { project: pp, opts });
      let sql = 'SELECT * FROM notes WHERE project_path = ?';
      const params = [pp];
      if (opts.file) { sql += ' AND file = ?'; params.push(opts.file); }
      if (opts.source) { sql += ' AND source = ?'; params.push(opts.source); }
      if (opts.session_id) { sql += ' AND session_id = ?'; params.push(opts.session_id); }
      if (opts.node_id) { sql += ' AND node_id = ?'; params.push(opts.node_id); }
      if (opts.node_id_prefix) {
        sql += " AND node_id LIKE ? ESCAPE '\\'";
        params.push(escapeLike(opts.node_id_prefix) + '%');
      }
      sql += ' ORDER BY created_at DESC, id DESC';
      const limit = opts.limit ?? 50;
      sql += ' LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params);
    },

    getNoteEvents(opts = {}) {
      debugLog('db', 'getNoteEvents', { project: pp, opts });
      let sql = 'SELECT * FROM note_events WHERE project_path = ?';
      const params = [pp];
      if (opts.note_id) { sql += ' AND note_id = ?'; params.push(opts.note_id); }
      if (opts.event_type) { sql += ' AND event_type = ?'; params.push(opts.event_type); }
      if (opts.session_id) { sql += ' AND session_id = ?'; params.push(opts.session_id); }
      sql += ' ORDER BY ts ASC, id ASC';
      const limit = opts.limit ?? 100;
      sql += ' LIMIT ?';
      params.push(limit);
      return db.prepare(sql).all(...params);
    },

    // Per-session surface cooldown: has ANY note of this semantic node already been
    // surfaced to this session? Node-keyed (not note-keyed) on purpose — each ack
    // advances the head note id, so a note-keyed check would re-surface every turn.
    hasSurfacedNodeInSession(nodeId, sessionId) {
      debugLog('db', 'hasSurfacedNodeInSession', { project: pp, nodeId, sessionId });
      return !!db.prepare(
        `SELECT 1 FROM note_events ne JOIN notes n ON n.id = ne.note_id
         WHERE ne.project_path = ? AND ne.session_id = ? AND ne.event_type = 'surfaced' AND n.node_id = ?
         LIMIT 1`
      ).get(pp, sessionId, nodeId);
    },

    // C6 note retirement: how many times this node surfaced while its source
    // file was already missing (payload flag written by user-prompt-submit).
    countStaleMissingSurfaces(nodeId) {
      return db.prepare(
        `SELECT COUNT(*) AS cnt FROM note_events ne JOIN notes n ON n.id = ne.note_id
         WHERE ne.project_path = ? AND ne.event_type = 'surfaced' AND n.node_id = ?
           AND ne.payload LIKE '%"stale_missing":true%'`
      ).get(pp, nodeId).cnt;
    },

    // Sphere compliance, session+ack anchor: the Stop-hook harvest calls this with a
    // parsed [DG-CONTINUE/PIVOT/PAUSE] tag. Matching happens in the surfaced note's
    // OWN node namespace (the tag echoes it) — never against the edit's assignFeature
    // node; the two namespaces are disjoint in live data. The echo is REQUIRED: a
    // bare tag is also the answer format of the pre-edit cycle-warn directive, and
    // crediting it (even in a single-node session — the common case) would count
    // cycle answers as sphere compliance. Unmatched acks under-count conservatively.
    ackNoteCompliance(sessionId, { outcome, nodeId, reason } = {}) {
      const run = () => {
        if (!nodeId) return { emitted: 0, reasonCode: 'echoless' };
        const sameFile = (sourceFile) => {
          if (!sourceFile) return null;
          return !!db.prepare(
            'SELECT 1 FROM changes WHERE project_path = ? AND session_id = ? AND file = ? LIMIT 1'
          ).get(pp, sessionId, sourceFile);
        };
        const candidates = db.prepare(UNTRACKED_SURFACED_SQL).all(pp, sessionId, pp, sessionId);
        const matched = candidates.filter(c => c.node_id === nodeId);
        if (matched.length === 0) return { emitted: 0, reasonCode: 'unmatched' };
        // NO head-advance check here: the canonical read→comply→layer loop layers the
        // new head BEFORE this harvest runs (stop.js order), so checking would score
        // every success as 'superseded'. 'superseded' belongs to finalize.
        let emitted = 0;
        for (const cand of matched) {
          this.insertNoteEvent({
            note_id: cand.note_id,
            session_id: sessionId,
            change_id: null,
            event_type: 'complied',
            payload: {
              outcome, via: 'stop_ack', echo: !!nodeId, node_id: cand.node_id,
              same_file: sameFile(cand.source_file),
              reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
            },
          });
          emitted++;
        }
        debugLog('db', 'ackNoteCompliance', { project: pp, sessionId, emitted, nodeId: nodeId || null, outcome });
        return { emitted, reasonCode: 'ok' };
      };
      return db.transaction(run).immediate();
    },

    // Shared body for the two finalize paths (SessionEnd clean-close and the
    // SessionStart orphan backstop). Marks each surfaced-untracked note of the
    // session: 'superseded' if the node head moved past it, else `unackedType`.
    // TRANSACTION-AGNOSTIC by design — the caller owns the transaction so the
    // backstop can bound its write-lock to ONE session (a single big transaction
    // over many orphans would block concurrent terminals for the whole loop).
    // `unackedType`: 'ignored' on a clean close (the session had its full chance
    // to ack), 'lapsed' from the backstop (the session died mid-flight — we
    // cannot know it would not have acked on a turn that never came).
    finalizeSurfacedForSession(sessionId, { via, unackedType }) {
      const candidates = db.prepare(UNTRACKED_SURFACED_SQL).all(pp, sessionId, pp, sessionId);
      let emitted = 0;
      for (const cand of candidates) {
        const head = cand.node_id ? this.getHeadNoteByNode(cand.node_id) : null;
        const superseded = head && head.id !== cand.note_id;
        const sameFile = cand.source_file
          ? !!db.prepare(
              'SELECT 1 FROM changes WHERE project_path = ? AND session_id = ? AND file = ? LIMIT 1'
            ).get(pp, sessionId, cand.source_file)
          : null;
        this.insertNoteEvent({
          note_id: cand.note_id,
          session_id: sessionId,
          change_id: null,
          event_type: superseded ? 'superseded' : unackedType,
          payload: { outcome: 'no_ack', via, node_id: cand.node_id, same_file: sameFile },
        });
        emitted++;
      }
      return emitted;
    },

    // SessionEnd backstop: whatever is still surfaced-untracked when the session
    // closes was never acknowledged — 'superseded' if the head moved past the note,
    // else 'ignored'. Runs ONLY at SessionEnd: an early 'ignored' on a mid-session
    // turn would permanently block (via the tracked-existence dedup) an ack arriving
    // on a later turn.
    finalizeNoteCompliance(sessionId) {
      const emitted = db.transaction(() =>
        this.finalizeSurfacedForSession(sessionId, { via: 'session_end_finalize', unackedType: 'ignored' })
      ).immediate();
      debugLog('db', 'finalizeNoteCompliance', { project: pp, sessionId, emitted });
      return emitted;
    },

    // SessionStart orphan backstop: a terminal hard-kill never fires SessionEnd, so
    // that session's surfaced-untracked notes never get a terminal outcome. On the
    // next SessionStart, finalize PRIOR sessions whose last activity is older than
    // `staleAfterHours` as 'lapsed'. Staleness is the only guard against finalizing a
    // still-live parallel terminal, so it must be conservative.
    finalizeStaleSessions({ excludeSessionId, staleAfterHours } = {}) {
      const hours = Number(staleAfterHours);
      if (!Number.isFinite(hours) || hours <= 0) return { sessions: 0, emitted: 0 };

      // Candidate sessions are enumerated from note_events (NOT the sessions table):
      // backfill/Desktop channels create session_ids that never call insertSession,
      // so those orphans exist only in note_events/changes. A NULL session_id can't
      // be attributed to a run, so `session_id != ?` (NULL-falsy) correctly drops it.
      const candidates = db.prepare(`
        SELECT DISTINCT ne.session_id AS session_id
        FROM note_events ne
        WHERE ne.project_path = ? AND ne.event_type = 'surfaced'
          AND ne.session_id IS NOT NULL AND ne.session_id != ?
          AND ne.note_id NOT IN (
            SELECT note_id FROM note_events c
            WHERE c.project_path = ? AND c.session_id = ne.session_id
              AND c.event_type IN ('complied', 'ignored', 'superseded', 'lapsed')
          )
      `).all(pp, excludeSessionId ?? '', pp).map(r => r.session_id);

      // Cutoff and last-activity are BOTH normalized via datetime(): backfill writes
      // ISO-8601 into changes.timestamp while note_events.ts is sqlite-format, so a
      // raw string MAX would mis-order the two formats. datetime() → one canonical
      // 'YYYY-MM-DD HH:MM:SS', making a lexicographic compare chronological.
      const { cutoff } = db.prepare(`SELECT datetime('now', ?) AS cutoff`).get(`-${hours} hours`);
      // datetime() yields NULL for an out-of-range modifier (absurd `hours`). Without
      // this the compare below (last_activity >= NULL → false) would fail OPEN and
      // finalize every candidate, including live sessions — staleness is the sole guard.
      if (!cutoff) return { sessions: 0, emitted: 0 };
      const activityStmt = db.prepare(`
        SELECT MAX(datetime(t)) AS last_activity FROM (
          SELECT ts AS t FROM note_events WHERE project_path = ? AND session_id = ?
          UNION ALL
          SELECT timestamp AS t FROM changes WHERE project_path = ? AND session_id = ?
        )`);

      let sessions = 0, emitted = 0;
      for (const sid of candidates) {
        const { last_activity } = activityStmt.get(pp, sid, pp, sid);
        // All timestamps unparseable → MAX(datetime) is NULL → treat as NOT stale
        // (fail-safe: never fabricate an outcome we can't time-justify).
        if (!last_activity || last_activity >= cutoff) continue;
        // Per-session transaction: bound the write-lock to one session so a
        // concurrent terminal (this feature's whole reason to exist) is not blocked
        // for the duration of the loop.
        const n = db.transaction(() =>
          this.finalizeSurfacedForSession(sid, { via: 'backstop_finalize', unackedType: 'lapsed' })
        ).immediate();
        sessions++;
        emitted += n;
      }
      debugLog('db', 'finalizeStaleSessions', { project: pp, sessions, emitted });
      return { sessions, emitted };
    },

    // Clone of getDetectionStats over note_events. compliance = complied/(complied+ignored);
    // compliance_of_surfaced = complied/surfaced. Both guard against divide-by-zero (→ 0).
    getNoteComplianceStats(opts = {}) {
      debugLog('db', 'getNoteComplianceStats', { project: pp });
      let where = 'WHERE project_path = ?';
      const params = [pp];
      if (opts.session_id) {
        where += ' AND session_id = ?';
        params.push(opts.session_id);
      }
      const rows = db.prepare(
        `SELECT event_type, COUNT(*) as cnt FROM note_events ${where} GROUP BY event_type`
      ).all(...params);
      const counts = { surfaced: 0, complied: 0, ignored: 0, superseded: 0, lapsed: 0 };
      let total = 0;
      for (const row of rows) {
        total += row.cnt;
        if (Object.prototype.hasOwnProperty.call(counts, row.event_type)) counts[row.event_type] = row.cnt;
      }
      // Re-surfacing the same note within a session must not dilute
      // compliance_of_surfaced: one (note, session) pair = one measurement
      // opportunity, mirroring the ≤1 compliance event the dedup allows per pair.
      counts.surfaced = db.prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT DISTINCT note_id, session_id FROM note_events ${where} AND event_type = 'surfaced'
         )`
      ).get(...params).c;
      const decided = counts.complied + counts.ignored;
      const compliance = decided > 0 ? counts.complied / decided : 0;
      const compliance_of_surfaced = counts.surfaced > 0 ? counts.complied / counts.surfaced : 0;
      return { total, ...counts, compliance, compliance_of_surfaced };
    },

    // Run a function inside a DB transaction (atomic multi-step writes like sphere
    // note capture). Nested db.transaction calls use savepoints, so callees that
    // open their own transaction (supersedePriorHead) compose correctly.
    // .immediate() takes the write lock up front: a concurrent writer then waits
    // via busy_timeout instead of failing mid-transaction with BUSY_SNAPSHOT,
    // which busy_timeout cannot retry under WAL.
    transaction(fn) { return db.transaction(fn).immediate(); },

    // The head note for a node = newest non-superseded row. id DESC, NOT created_at:
    // created_at is second-granular so multiple notes can share a timestamp; id is
    // the only monotonic tiebreaker.
    getHeadNoteByNode(nodeId) {
      debugLog('db', 'getHeadNoteByNode', { project: pp, nodeId });
      return db.prepare(
        `SELECT * FROM notes
         WHERE project_path = ? AND node_id = ? AND superseded_by IS NULL
         ORDER BY id DESC LIMIT 1`
      ).get(pp, nodeId);
    },

    // Collapse all current heads for a node into a single head (newId). Every head
    // except newId gets superseded_by = newId. No-op if newId is already the only head.
    supersedePriorHead(nodeId, newId) {
      debugLog('db', 'supersedePriorHead', { project: pp, nodeId, newId });
      const tx = db.transaction(() => {
        // Guard: newId must itself be a current head of this node. Otherwise
        // superseding every head would leave the node with ZERO heads and a
        // dangling superseded_by — silent note loss.
        const isHead = db.prepare(
          'SELECT 1 FROM notes WHERE project_path = ? AND node_id = ? AND id = ? AND superseded_by IS NULL'
        ).get(pp, nodeId, newId);
        if (!isHead) {
          debugLog('db', 'supersedePriorHead: newId is not a head, skip', { nodeId, newId });
          return;
        }
        db.prepare(
          `UPDATE notes SET superseded_by = ?
           WHERE project_path = ? AND node_id = ? AND superseded_by IS NULL AND id != ?`
        ).run(newId, pp, nodeId, newId);
      });
      tx();
    },

    // Re-parent all notes under fromNodeId onto toNodeId, then reconcile so toNodeId
    // has exactly one head: keep the newest by id, supersede the rest.
    mergeNodes(fromNodeId, toNodeId) {
      debugLog('db', 'mergeNodes', { project: pp, fromNodeId, toNodeId });
      const tx = db.transaction(() => {
        db.prepare(
          'UPDATE notes SET node_id = ? WHERE project_path = ? AND node_id = ?'
        ).run(toNodeId, pp, fromNodeId);
        const head = db.prepare(
          `SELECT id FROM notes
           WHERE project_path = ? AND node_id = ? AND superseded_by IS NULL
           ORDER BY id DESC LIMIT 1`
        ).get(pp, toNodeId);
        if (head) {
          db.prepare(
            `UPDATE notes SET superseded_by = ?
             WHERE project_path = ? AND node_id = ? AND superseded_by IS NULL AND id != ?`
          ).run(head.id, pp, toNodeId, head.id);
        }
      });
      tx();
    },

    // Thin wrapper: ALL notes for a semantic node (newest first). Read path stays
    // model-free — node_id is resolved by the keyword map, not embeddings. Passes an
    // explicit unbounded limit: getNotes defaults to LIMIT 50, which would silently
    // truncate a feature's layered history (undercounting notes and dropping the
    // oldest chain layers) once it exceeds 50 notes.
    getNotesByNode(nodeId) {
      return this.getNotes({ node_id: nodeId, limit: Number.MAX_SAFE_INTEGER });
    },

    // --- features (S1 semantic placement) ---
    // Each row is a "country" (feature) under a "continent" (domain). centroid_embedding
    // is the running-mean unit vector of member changes' embeddings; NULL when the feature
    // was only ever seen with embeddings disabled (degraded path). Every query project-scoped.
    getFeature(nodeId) {
      debugLog('db', 'getFeature', { project: pp, nodeId });
      return db.prepare(
        'SELECT * FROM features WHERE project_path = ? AND node_id = ?'
      ).get(pp, nodeId) || null;
    },

    getFeaturesByContinent(continent) {
      debugLog('db', 'getFeaturesByContinent', { project: pp, continent });
      return db.prepare(
        'SELECT * FROM features WHERE project_path = ? AND continent = ? ORDER BY member_count DESC, id ASC'
      ).all(pp, continent);
    },

    // All features across every continent for this project (S2.B map/consumer needs
    // the full set in one read). project_path scoped like every sibling.
    getAllFeatures() {
      debugLog('db', 'getAllFeatures', { project: pp });
      return db.prepare(
        'SELECT * FROM features WHERE project_path = ? ORDER BY continent ASC, member_count DESC, id ASC'
      ).all(pp);
    },

    // Source-agnostic upsert. embedding is the ALREADY-computed new centroid (running
    // mean, unit-normalized by the caller) — this method only stores it. When embedding
    // is null (degraded, embeddings disabled) only member_count moves; the stored
    // centroid stays as it was (NULL for a brand-new degraded feature).
    upsertFeatureCentroid({ continent, country, node_id, embedding }) {
      debugLog('db', 'upsertFeatureCentroid', { project: pp, node_id, hasEmbedding: !!embedding });
      const existing = db.prepare(
        'SELECT id FROM features WHERE project_path = ? AND node_id = ?'
      ).get(pp, node_id);
      if (existing) {
        if (embedding) {
          db.prepare(
            `UPDATE features SET centroid_embedding = ?, member_count = member_count + 1,
               updated_at = CURRENT_TIMESTAMP
             WHERE project_path = ? AND node_id = ?`
          ).run(embedding, pp, node_id);
        } else {
          db.prepare(
            `UPDATE features SET member_count = member_count + 1, updated_at = CURRENT_TIMESTAMP
             WHERE project_path = ? AND node_id = ?`
          ).run(pp, node_id);
        }
        return existing.id;
      }
      return db.prepare(
        `INSERT INTO features (project_path, continent, country, node_id, centroid_embedding, member_count)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(pp, sanitize(continent), sanitize(country), sanitize(node_id), embedding || null).lastInsertRowid;
    },

    // --- threshold_params (adaptive threshold) ---
    getThresholdParams(category, subcategory) {
      debugLog('db', 'getThresholdParams', { project: pp, category, subcategory });
      return db.prepare(
        'SELECT * FROM threshold_params WHERE project_path = ? AND category = ? AND subcategory IS ?'
      ).get(pp, category, subcategory || null) || null;
    },

    upsertThresholdParams(category, subcategory, alpha, beta, sampleCount) {
      debugLog('db', 'upsertThresholdParams', { project: pp, category, subcategory, alpha, beta });
      const existing = this.getThresholdParams(category, subcategory);
      if (existing) {
        return db.prepare(
          `UPDATE threshold_params SET alpha = ?, beta = ?, sample_count = ?, last_updated = datetime('now')
           WHERE project_path = ? AND category = ? AND subcategory IS ?`
        ).run(alpha, beta, sampleCount, pp, category, subcategory || null).changes;
      }
      return db.prepare(
        `INSERT INTO threshold_params (project_path, category, subcategory, alpha, beta, sample_count)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(pp, category, subcategory || null, alpha, beta, sampleCount).lastInsertRowid;
    },

    getAllThresholdParams() {
      debugLog('db', 'getAllThresholdParams', { project: pp });
      return db.prepare(
        'SELECT * FROM threshold_params WHERE project_path = ?'
      ).all(pp);
    },

    getDetectionPatternStats() {
      debugLog('db', 'getDetectionPatternStats', { project: pp });
      return db.prepare(`
        SELECT middleware_id, file, COUNT(*) as cnt,
          SUM(CASE WHEN classification = 'tp' THEN 1 ELSE 0 END) as tp_count,
          SUM(CASE WHEN classification = 'fp' THEN 1 ELSE 0 END) as fp_count
        FROM detection_log WHERE project_path = ?
        GROUP BY middleware_id, file
      `).all(pp);
    },

    // --- rich message queries ---
    getChangeHistory(sessionId, file, limit = 5) {
      debugLog('db', 'getChangeHistory', { project: pp, sessionId, file, limit });
      return db.prepare(`
        SELECT id, description, diff_text, timestamp, claude_verdict
        FROM changes
        WHERE project_path = ? AND session_id = ? AND file = ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
      `).all(pp, sessionId, file, limit);
    },

    getChangesByIds(ids) {
      if (!ids || ids.length === 0) return [];
      debugLog('db', 'getChangesByIds', { project: pp, count: ids.length });
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(
        `SELECT * FROM changes WHERE project_path = ? AND id IN (${placeholders})`
      ).all(pp, ...ids);
    },

    getErrorsByIds(ids) {
      if (!ids || ids.length === 0) return [];
      debugLog('db', 'getErrorsByIds', { project: pp, count: ids.length });
      const placeholders = ids.map(() => '?').join(',');
      return db.prepare(
        `SELECT * FROM error_outputs WHERE project_path = ? AND id IN (${placeholders})`
      ).all(pp, ...ids);
    },

    getChangeById(id) {
      debugLog('db', 'getChangeById', { project: pp, id });
      return db.prepare(
        'SELECT * FROM changes WHERE project_path = ? AND id = ?'
      ).get(pp, id) || null;
    },

    // --- blame_cache ---
    insertBlameCache(filePath, commitHash, blameData) {
      debugLog('db', 'insertBlameCache', { project: pp, filePath, commitHash });
      db.prepare(
        'INSERT OR REPLACE INTO blame_cache (project_path, file_path, commit_hash, blame_data) VALUES (?, ?, ?, ?)'
      ).run(pp, filePath, commitHash, blameData);
    },

    getBlameCache(filePath, commitHash) {
      return db.prepare(
        'SELECT * FROM blame_cache WHERE project_path = ? AND file_path = ? AND commit_hash = ?'
      ).get(pp, filePath, commitHash) || null;
    },

    deleteOldBlameCacheEntries(days) {
      debugLog('db', 'deleteOldBlameCacheEntries', { project: pp, days });
      const cutoff = new Date(Date.now() - days * 86400000).toISOString();
      return db.prepare('DELETE FROM blame_cache WHERE project_path = ? AND created_at < ?').run(pp, cutoff).changes;
    },

    invalidateBlameCacheFile(filePath) {
      debugLog('db', 'invalidateBlameCacheFile', { project: pp, filePath });
      return db.prepare('DELETE FROM blame_cache WHERE project_path = ? AND file_path = ?').run(pp, filePath).changes;
    },

    flushBlameCache() {
      debugLog('db', 'flushBlameCache', { project: pp });
      return db.prepare('DELETE FROM blame_cache WHERE project_path = ?').run(pp).changes;
    },

    // --- FTS5 ---
    searchFts(query) {
      debugLog('db', 'searchFts', { project: pp, query });
      try {
        return db.prepare(`
          SELECT c.* FROM changes_fts f
          JOIN changes c ON c.id = f.rowid
          WHERE changes_fts MATCH ? AND c.project_path = ?
          ORDER BY rank
        `).all(query, pp);
      } catch (err) {
        debugLog('db', 'searchFts error', { query, error: String(err) });
        return [];
      }
    },

    // --- FIFO ---
    runFifo(maxEntries) {
      debugLog('db', 'runFifo', { project: pp, maxEntries });
      const count = this.getChangeCount();
      if (count <= maxEntries) return 0;

      const toDelete = count - maxEntries;
      const protectedChangeIds = db.prepare(
        'SELECT DISTINCT change_id FROM protected_zones WHERE project_path = ?'
      ).all(pp).map(r => r.change_id);

      let sql;
      const params = [pp];
      if (protectedChangeIds.length > 0) {
        const placeholders = protectedChangeIds.map(() => '?').join(',');
        sql = `SELECT id FROM changes
          WHERE project_path = ? AND id NOT IN (${placeholders})
          ORDER BY timestamp ASC LIMIT ?`;
        params.push(...protectedChangeIds, toDelete);
      } else {
        sql = 'SELECT id FROM changes WHERE project_path = ? ORDER BY timestamp ASC LIMIT ?';
        params.push(toDelete);
      }

      const rows = db.prepare(sql).all(...params);
      if (rows.length === 0) return 0;

      const ids = rows.map(r => r.id);
      const idPlaceholders = ids.map(() => '?').join(',');

      const deleteFn = db.transaction(() => {
        // issues.fix_change_id references changes: detach before evicting.
        db.prepare(`UPDATE issues SET fix_change_id = NULL WHERE project_path = ? AND fix_change_id IN (${idPlaceholders})`).run(pp, ...ids);
        db.prepare(`DELETE FROM error_outputs WHERE change_id IN (${idPlaceholders})`).run(...ids);
        db.prepare(`DELETE FROM changes WHERE id IN (${idPlaceholders})`).run(...ids);
      });
      deleteFn();

      return ids.length;
    },

    // --- orphan cleanup ---
    getDistinctProjectPaths() {
      return db.prepare('SELECT DISTINCT project_path FROM sessions')
        .all().map(r => r.project_path);
    },

    deleteByProjectPath(targetPath) {
      const normalizedTarget = targetPath.replace(/\\/g, '/');
      debugLog('db', 'deleteByProjectPath', { targetPath: normalizedTarget });
      const del = db.transaction(() => {
        db.prepare('DELETE FROM features WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM threshold_params WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM detection_log WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM blame_cache WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM protected_zones WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM error_outputs WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM note_events WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM notes WHERE project_path = ?').run(normalizedTarget);
        // changes ⇄ issues reference each other (fix_change_id / related_issue_id):
        // break the cycle first, then delete the child side before its parent.
        db.prepare('UPDATE issues SET fix_change_id = NULL WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM changes WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM issues WHERE project_path = ?').run(normalizedTarget);
        db.prepare('DELETE FROM sessions WHERE project_path = ?').run(normalizedTarget);
      });
      del();
    },

    // --- backfill_cursor (transcript-global, V14) ---
    // INTENTIONAL EXCEPTION to the multi-tenant project_path rule: backfill_cursor
    // is keyed by transcript_path only, with NO project_path filter. One transcript
    // can span multiple cwds (e.g. on the Desktop, Claude Code reports the home cwd),
    // so a single transcript maps to potentially many projects. The cursor tracks how
    // far a *transcript file* has been read — that is a transcript-level fact, not a
    // project-level one. These methods live on the per-project proxy only for ergonomics.
    getBackfillCursor(transcriptPath) {
      const row = db.prepare(
        'SELECT last_size FROM backfill_cursor WHERE transcript_path = ?'
      ).get(transcriptPath);
      return row ? row.last_size : 0;
    },

    // Load ALL cursors in one query so the backfill scan can look them up from a
    // Map instead of issuing one SELECT per transcript file (latency on every
    // SessionStart). Returns a Map<transcript_path, last_size>.
    getAllBackfillCursors() {
      const rows = db.prepare('SELECT transcript_path, last_size FROM backfill_cursor').all();
      const map = new Map();
      for (const r of rows) map.set(r.transcript_path, r.last_size);
      return map;
    },

    setBackfillCursor(transcriptPath, size) {
      debugLog('db', 'setBackfillCursor', { transcriptPath, size });
      return db.prepare(
        `INSERT INTO backfill_cursor (transcript_path, last_size, last_processed_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(transcript_path) DO UPDATE SET
           last_size = excluded.last_size,
           last_processed_at = CURRENT_TIMESTAMP`
      ).run(transcriptPath, size).changes;
    },
  };
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, openDb, closeDb, getDbPath, classifyOutcome };
