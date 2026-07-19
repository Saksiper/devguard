'use strict';

function parseArgs(argv) {
  const args = { project: null, list: false, classify: null, as: null, note: null, addFn: false, report: false, session: false, notes: false, source: null, nodePrefix: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) {
      args.project = argv[++i];
    } else if (argv[i] === '--list') {
      args.list = true;
    } else if (argv[i] === '--classify' && argv[i + 1]) {
      args.classify = parseInt(argv[++i], 10);
    } else if (argv[i] === '--as' && argv[i + 1]) {
      args.as = argv[++i];
    } else if (argv[i] === '--note' && argv[i + 1]) {
      args.note = argv[++i];
    } else if (argv[i] === '--add-fn') {
      args.addFn = true;
    } else if (argv[i] === '--report') {
      args.report = true;
    } else if (argv[i] === '--session') {
      args.session = true;
    } else if (argv[i] === '--notes') {
      args.notes = true;
    } else if (argv[i] === '--source' && argv[i + 1]) {
      args.source = argv[++i];
    } else if (argv[i] === '--node-prefix' && argv[i + 1]) {
      args.nodePrefix = argv[++i];
    }
  }
  return args;
}

function formatDetection(d, projectPrefix) {
  let file = (d.file || '').replace(/\\/g, '/');
  if (projectPrefix && file.startsWith(projectPrefix)) file = file.slice(projectPrefix.length);
  return {
    id: d.id,
    decision: d.decision,
    file,
    type: d.type || null,
    level: d.level ?? null,
    confidence: d.confidence ?? null,
    middleware_id: d.middleware_id || null,
    message: d.message || null,
    detected_at: d.detected_at || null,
    // Layer 2 — what Claude did after the warning
    next_change_same_file: d.next_change_same_file ?? null,
    next_change_outcome: d.next_change_outcome || null,
    next_change_reasoning: d.next_change_reasoning || null,
  };
}

function computeMetrics(stats) {
  const precision = (stats.tp + stats.fp) > 0 ? +(stats.tp / (stats.tp + stats.fp)).toFixed(4) : 0;
  const recall = (stats.tp + stats.fn) > 0 ? +(stats.tp / (stats.tp + stats.fn)).toFixed(4) : 0;
  return { precision, recall };
}

function doList(db, sessionId, projectPrefix) {
  const opts = { unclassified: true };
  if (sessionId) opts.session_id = sessionId;
  const detections = db.getDetections(opts);
  const formatted = detections.map(d => formatDetection(d, projectPrefix));
  const output = {
    session: sessionId || 'all',
    count: formatted.length,
    unclassified: formatted,
  };
  console.log(JSON.stringify(output, null, 2));
}

function doClassify(db, id, classification, note) {
  const valid = ['tp', 'fp'];
  if (!valid.includes(classification)) {
    console.log(`Error: --as value must be "tp" or "fp". Got: "${classification}"`);
    process.exit(1);
  }
  if (isNaN(id)) {
    console.log('Error: --classify value must be a number.');
    process.exit(1);
  }
  const changed = db.classifyDetection(id, classification, note);
  if (changed > 0) {
    console.log(JSON.stringify({ ok: true, id, classification, note: note || null }));
  } else {
    console.log(JSON.stringify({ ok: false, error: `ID ${id} not found or does not belong to this project.` }));
    process.exit(1);
  }
}

function doAddFn(db, sessionId, note) {
  if (!note) {
    console.log('Error: --note required (describe the missed cycle).');
    process.exit(1);
  }
  const id = db.insertFalseNegative({ session_id: sessionId, note });
  console.log(JSON.stringify({ ok: true, id, classification: 'fn', note }));
}

function doReport(db, sessionId) {
  const opts = {};
  if (sessionId) opts.session_id = sessionId;
  const stats = db.getDetectionStats(opts);
  const m = computeMetrics(stats);

  const scope = sessionId ? `Latest Session (${sessionId.substring(0, 8)}...)` : 'All Time';
  const lines = [];
  lines.push(`## DevGuard Dogfood Report — ${scope}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total events | ${stats.total} |`);
  lines.push(`| True Positive (TP) | ${stats.tp} |`);
  lines.push(`| False Positive (FP) | ${stats.fp} |`);
  lines.push(`| False Negative (FN) | ${stats.fn} |`);
  lines.push(`| Unclassified | ${stats.unclassified} |`);
  const fpRate = (stats.fp + stats.tp) > 0 ? (stats.fp / (stats.fp + stats.tp) * 100).toFixed(1) : '0.0';
  lines.push(`| Precision | ${(m.precision * 100).toFixed(1)}% |`);
  lines.push(`| Recall | ${(m.recall * 100).toFixed(1)}% |`);
  lines.push(`| FP Rate | ${fpRate}% |`);
  lines.push('');

  if (parseFloat(fpRate) > 5.0) {
    lines.push(`> **WARNING:** FP rate ${fpRate}% — target <5%`);
    lines.push('');
  }

  if (stats.total === 0) {
    lines.push('No detection_log records yet. Run DevGuard in an active session to collect data.');
  } else if (stats.unclassified > 0) {
    lines.push(`${stats.unclassified} event${stats.unclassified !== 1 ? 's' : ''} not yet classified. Use \`--list\` to view and \`--classify\` to label them.`);
  }

  try {
    const { buildComplianceSection } = require('./compliance-section');
    const section = buildComplianceSection(db, sessionId ? { session_id: sessionId } : {});
    if (section.length) { lines.push(''); lines.push(...section); }
  } catch { /* note_events may not exist */ }

  console.log(lines.join('\n'));
}

function doNotes(db, sessionId, source, nodePrefix) {
  const opts = {};
  if (sessionId) opts.session_id = sessionId;
  if (source) opts.source = source;
  if (nodePrefix) opts.node_id_prefix = nodePrefix;
  const notes = db.getNotes(opts);
  const output = {
    source: source || 'all',
    node_prefix: nodePrefix || 'all',
    count: notes.length,
    notes,
  };
  console.log(JSON.stringify(output, null, 2));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.project) {
    console.log('Usage:');
    console.log('  node dogfood.js --project <path> --list [--session]');
    console.log('  node dogfood.js --project <path> --classify <id> --as <tp|fp> [--note "..."]');
    console.log('  node dogfood.js --project <path> --add-fn --note "..." [--session]');
    console.log('  node dogfood.js --project <path> --report [--session]');
    console.log('  node dogfood.js --project <path> --notes [--source <name>] [--node-prefix <prefix>] [--session]');
    process.exit(1);
  }

  const { getDb, closeDb } = require('../engine/db');

  try {
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const projectPath = normalizeProjectPath(args.project);
    const db = getDb(projectPath);
    const projectPrefix = projectPath.replace(/\\/g, '/').replace(/\/$/, '') + '/';

    let sessionId = null;
    if (args.session) {
      const latest = db.getLatestSession();
      if (latest) {
        sessionId = latest.session_id;
      } else {
        console.log('No active session found.');
        closeDb();
        return;
      }
    }

    if (args.list) {
      doList(db, sessionId, projectPrefix);
    } else if (args.classify !== null) {
      if (!args.as) {
        console.log('Error: --as <tp|fp> required.');
        process.exit(1);
      }
      doClassify(db, args.classify, args.as, args.note);
    } else if (args.addFn) {
      doAddFn(db, sessionId, args.note);
    } else if (args.report) {
      doReport(db, sessionId);
    } else if (args.notes) {
      doNotes(db, sessionId, args.source, args.nodePrefix);
    } else {
      console.log('Select a mode: --list, --classify, --add-fn, --report, or --notes');
      process.exit(1);
    }

    closeDb();
  } catch (err) {
    console.log(`Error: ${err.message}`);
    try { require('../engine/db').closeDb(); } catch { /* cleanup */ }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, formatDetection, computeMetrics };
