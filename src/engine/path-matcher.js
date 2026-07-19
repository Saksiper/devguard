'use strict';

// Simple path matcher used by hook early-exit logic to skip noise files
// (.claude/, node_modules/, MEMORY.md, etc.) from the detection pipeline.
//
// Supports two pattern types, both case-insensitive:
//   - Segment match: "/.claude/", "/node_modules/" — substring check against
//     the normalized path (with a trailing slash appended so trailing-dir
//     matches work for file paths)
//   - Basename match: "MEMORY.md" — exact match against the path basename
//
// No glob wildcards. Forward-slash only; caller normalizes backslashes.

function isExcluded(filePath, config) {
  if (!filePath || typeof filePath !== 'string') return false;
  const normalized = filePath.replace(/\\/g, '/');
  const withTrailing = normalized + '/';
  const lower = withTrailing.toLowerCase();

  const segments = (config && Array.isArray(config.excluded_path_segments))
    ? config.excluded_path_segments
    : [];
  for (const seg of segments) {
    if (typeof seg !== 'string' || !seg) continue;
    if (lower.includes(seg.toLowerCase())) return true;
  }

  const basenames = (config && Array.isArray(config.excluded_basenames))
    ? config.excluded_basenames
    : [];
  if (basenames.length > 0) {
    const parts = normalized.split('/').filter(Boolean);
    const base = parts.length > 0 ? parts[parts.length - 1] : '';
    if (base) {
      const baseLower = base.toLowerCase();
      for (const bn of basenames) {
        if (typeof bn !== 'string' || !bn) continue;
        // Case-insensitive on Windows filesystems; case-sensitive elsewhere
        if (process.platform === 'win32') {
          if (baseLower === bn.toLowerCase()) return true;
        } else {
          if (base === bn) return true;
        }
      }
    }
  }
  return false;
}

module.exports = { isExcluded };
