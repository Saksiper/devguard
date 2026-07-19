'use strict';

const { debugLog } = require('./debug-log');
const { getBlame } = require('./blame-cache');

function hasProtectedCommit(db, filePath) {
  return db.hasProtectedFile(filePath);
}

function checkProtection(db, filePath, lineRanges, cwd, activeIssueId) {
  if (!lineRanges || lineRanges.length === 0) return null;

  const matchedZones = [];

  const protectedCommits = db.getProtectedCommitsForFile(filePath);
  if (protectedCommits.length > 0) {
    const commitSet = new Set(protectedCommits);
    const zones = db.getProtectedZones({ file: filePath });
    for (const range of lineRanges) {
      const blameData = getBlame(db, filePath, range.start, range.end, cwd);
      for (const entry of blameData) {
        if (commitSet.has(entry.commitHash)) {
          for (const zone of zones) {
            if (zone.protected_commit === entry.commitHash) {
              if (activeIssueId && zone.issue_id === activeIssueId) continue;
              matchedZones.push({
                zone_id: zone.id,
                issue_id: zone.issue_id,
                protected_commit: zone.protected_commit,
                reason: zone.reason,
                lineNo: entry.lineNo,
              });
            }
          }
        }
      }
    }
  }

  const tempZones = db.getTempProtectionsForFile(filePath);
  for (const tz of tempZones) {
    if (tz.temp_lines_start === null || tz.temp_lines_start === undefined || tz.temp_lines_end === null || tz.temp_lines_end === undefined) continue;
    if (activeIssueId && tz.issue_id === activeIssueId) continue;
    for (const range of lineRanges) {
      if (range.start <= tz.temp_lines_end && range.end >= tz.temp_lines_start) {
        matchedZones.push({
          zone_id: tz.id,
          issue_id: tz.issue_id,
          reason: tz.reason,
          temp: true,
          lineNo: null,
        });
      }
    }
  }

  if (matchedZones.length === 0) return null;

  const uniqueZones = deduplicateZones(matchedZones);
  return {
    hit: true,
    zones: uniqueZones,
    message: formatProtectionMessage(db, uniqueZones),
  };
}

function deduplicateZones(zones) {
  const seen = new Set();
  return zones.filter(z => {
    const key = `${z.zone_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatProtectionMessage(db, zones) {
  let allIssues = [];
  try { allIssues = db.getIssues({}); } catch { /* graceful */ }

  const lines = [];
  for (const z of zones) {
    let issueTitle = 'unknown issue';
    const issue = allIssues.find(i => i.id === z.issue_id);
    if (issue && issue.title) issueTitle = issue.title;

    const reasonSuffix = z.reason ? ` (${z.reason})` : '';
    if (z.temp) {
      lines.push(`WARNING: These lines were added for the "${issueTitle}" fix${reasonSuffix} (not yet committed). Modifying them may reintroduce the issue.`);
    } else {
      const shortHash = z.protected_commit ? z.protected_commit.substring(0, 7) : '?';
      lines.push(`WARNING: These lines were added for the "${issueTitle}" fix${reasonSuffix} (${shortHash}). Modifying them may reintroduce the issue. Preserve the fix while making changes.`);
    }
  }
  return lines.join('\n');
}

function createTempProtection(db, data) {
  debugLog('protection', 'createTempProtection', { file: data.file });
  return db.insertProtectedZone({
    issue_id: data.issueId,
    change_id: data.changeId,
    file: data.file,
    temp_lines_start: data.startLine ?? null,
    temp_lines_end: data.endLine ?? null,
    temp_protection: 1,
    reason: data.reason || null,
  });
}

function promoteProtection(db, commitHash, files) {
  debugLog('protection', 'promoteProtection', { commitHash: commitHash.substring(0, 7), fileCount: files.length });
  return db.promoteProtection(commitHash, files);
}

module.exports = {
  hasProtectedCommit,
  checkProtection,
  createTempProtection,
  promoteProtection,
  formatProtectionMessage,
};
