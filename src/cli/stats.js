'use strict';

function parseArgs(argv) {
  const args = { project: null, session: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--project' && argv[i + 1]) {
      args.project = argv[++i];
    } else if (argv[i] === '--session') {
      args.session = true;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.project) {
    console.log('Usage: node stats.js --project <path> [--session]');
    process.exit(1);
  }

  const { getDb, closeDb } = require('../engine/db');

  try {
    const { normalizeProjectPath } = require('../engine/normalize-path');
    const db = getDb(normalizeProjectPath(args.project));
    const sessionFilter = {};

    let title = 'All Time';
    if (args.session) {
      const latest = db.getLatestSession();
      if (latest) {
        sessionFilter.session_id = latest.session_id;
        title = `Latest Session (${latest.session_id.substring(0, 8)}...)`;
      } else {
        console.log('No active session found.');
        closeDb();
        return;
      }
    }

    const changes = db.getChanges({ ...sessionFilter, limit: 10000 });
    const issues = db.getIssues({});
    const openIssues = issues.filter(i => i.status === 'open');
    const zones = db.getProtectedZones({});
    const sessionCount = db.getSessionCount();

    const projectPrefix = args.project.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const fileCounts = {};
    for (const c of changes) {
      let key = (c.file || '').replace(/\\/g, '/');
      if (key.startsWith(projectPrefix)) key = key.slice(projectPrefix.length);
      fileCounts[key] = (fileCounts[key] || 0) + 1;
    }
    const topFiles = Object.entries(fileCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const lines = [];
    lines.push(`## DevGuard Statistics — ${title}`);
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Session count | ${sessionCount} |`);
    lines.push(`| Total changes | ${changes.length} |`);
    lines.push(`| Active issues | ${openIssues.length} |`);
    lines.push(`| Protected zones | ${zones.length} |`);
    lines.push('');

    if (topFiles.length > 0) {
      lines.push('### Most Edited Files');
      for (const [file, count] of topFiles) {
        const shortFile = file.length > 60 ? '...' + file.slice(-57) : file;
        lines.push(`- ${shortFile} (${count}x)`);
      }
      lines.push('');
    }

    if (openIssues.length > 0) {
      lines.push('### Active Issues');
      for (const issue of openIssues.slice(0, 5)) {
        lines.push(`- ${issue.title || 'untitled'}`);
      }
      lines.push('');
    }

    try {
      const detectionStats = db.getDetectionStats(sessionFilter);
      if (detectionStats.total > 0) {
        const fpRate = (detectionStats.tp + detectionStats.fp) > 0
          ? (detectionStats.fp / (detectionStats.tp + detectionStats.fp) * 100).toFixed(1)
          : '0.0';
        const precision = (detectionStats.tp + detectionStats.fp) > 0
          ? (detectionStats.tp / (detectionStats.tp + detectionStats.fp) * 100).toFixed(1)
          : '100.0';
        lines.push('### Detection Quality (detection_log)');
        lines.push(`| TP | FP | Unclassified | Precision | FP Rate |`);
        lines.push(`|----|----|--------------|-----------|---------| `);
        lines.push(`| ${detectionStats.tp} | ${detectionStats.fp} | ${detectionStats.unclassified} | ${precision}% | ${fpRate}% |`);
        if (parseFloat(fpRate) > 5.0) {
          lines.push(`> **WARNING:** FP rate ${fpRate}% — target <5%`);
        }
        lines.push('');
      }
    } catch { /* detection_log may not exist */ }

    try {
      const { buildComplianceSection } = require('./compliance-section');
      lines.push(...buildComplianceSection(db, sessionFilter));
    } catch { /* note_events may not exist */ }

    if (zones.length > 0) {
      lines.push('### Protected Files');
      const zoneFileCounts = {};
      for (const z of zones) {
        let key = (z.file || '').replace(/\\/g, '/');
        if (key.startsWith(projectPrefix)) key = key.slice(projectPrefix.length);
        zoneFileCounts[key] = (zoneFileCounts[key] || 0) + 1;
      }
      const uniqueZoneFiles = Object.entries(zoneFileCounts).slice(0, 5);
      for (const [f, cnt] of uniqueZoneFiles) {
        const shortFile = f.length > 60 ? '...' + f.slice(-57) : f;
        lines.push(`- ${shortFile} (${cnt} zone${cnt !== 1 ? 's' : ''})`);
      }
      lines.push('');
    }

    console.log(lines.join('\n'));
    closeDb();
  } catch (err) {
    console.log(`Error: ${err.message}`);
    try { closeDb(); } catch { /* cleanup */ }
    process.exit(1);
  }
}

main();
