import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const MATCHER_PATH = path.resolve(__dirname, '../../src/engine/path-matcher.js');

function loadFresh() {
  delete require.cache[require.resolve(MATCHER_PATH)];
  return require(MATCHER_PATH);
}

describe('path-matcher', () => {
  const DEFAULT_CONFIG = {
    excluded_path_segments: [
      '/.claude/',
      '/.superpowers/',
      '/node_modules/',
      '/.git/',
    ],
    excluded_basenames: ['MEMORY.md'],
  };

  describe('isExcluded — segments', () => {
    it('matches forward-slash .claude/ path', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/.claude/settings.json', DEFAULT_CONFIG)).toBe(true);
    });

    it('matches Windows backslash path after normalization', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('C:\\Users\\umut\\project\\node_modules\\lodash\\index.js', DEFAULT_CONFIG)).toBe(true);
    });

    it('matches .git/ anywhere in path', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/repo/.git/HEAD', DEFAULT_CONFIG)).toBe(true);
    });

    it('case-insensitive segment match', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/PROJ/.CLAUDE/x', DEFAULT_CONFIG)).toBe(true);
      expect(isExcluded('/PROJ/NODE_MODULES/x', DEFAULT_CONFIG)).toBe(true);
    });

    it('does NOT match real source code paths', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/proj/src/components/App.tsx', DEFAULT_CONFIG)).toBe(false);
      expect(isExcluded('/home/user/proj/backend/main.py', DEFAULT_CONFIG)).toBe(false);
    });

    it('does NOT match src/plans/ (real code, not dotclaude plans)', () => {
      const { isExcluded } = loadFresh();
      // Default config deliberately does not exclude /plans/
      expect(isExcluded('/home/user/proj/src/plans/roadmap.ts', DEFAULT_CONFIG)).toBe(false);
    });

    it('matches path ending with segment dir (trailing slash appended internally)', () => {
      const { isExcluded } = loadFresh();
      // Edge case: what if filePath itself IS the dir? Normally a file path,
      // but if someone passes a dir path, trailing slash should still catch it.
      expect(isExcluded('/home/user/.claude', DEFAULT_CONFIG)).toBe(true);
    });

    it('does NOT exclude every file when an ANCESTOR dir matches a segment', () => {
      const { isExcluded } = loadFresh();
      // A project living under a 'build/' ancestor must not have all its files
      // excluded — segment matching runs against the project-relative remainder.
      const proj = '/home/user/build/myapp';
      expect(isExcluded('/home/user/build/myapp/src/index.js', DEFAULT_CONFIG, proj)).toBe(false);
      // but a node_modules INSIDE the project is still excluded
      expect(isExcluded('/home/user/build/myapp/node_modules/x/i.js', DEFAULT_CONFIG, proj)).toBe(true);
    });

    it('without projectPath, keeps the legacy full-path behavior (backward compatible)', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/proj/src/index.js', DEFAULT_CONFIG)).toBe(false);
      expect(isExcluded('/home/user/proj/node_modules/x/i.js', DEFAULT_CONFIG)).toBe(true);
    });
  });

  describe('isExcluded — basenames', () => {
    it('matches MEMORY.md basename exactly', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/proj/MEMORY.md', DEFAULT_CONFIG)).toBe(true);
      expect(isExcluded('/home/user/.claude/projects/foo/memory/MEMORY.md', DEFAULT_CONFIG)).toBe(true);
    });

    it('does NOT match files containing MEMORY.md substring', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/proj/src/MEMORY.md.backup', DEFAULT_CONFIG)).toBe(false);
      expect(isExcluded('/home/user/proj/docs/OLD-MEMORY.md', DEFAULT_CONFIG)).toBe(false);
    });

    it.skipIf(process.platform !== 'win32')('basename matcher on Windows is case-insensitive', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/proj/memory.md', DEFAULT_CONFIG)).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('basename matcher on non-Windows is case-sensitive', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/proj/memory.md', DEFAULT_CONFIG)).toBe(false);
    });
  });

  describe('isExcluded — edge cases', () => {
    it('returns false for empty filePath', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('', DEFAULT_CONFIG)).toBe(false);
      expect(isExcluded(null, DEFAULT_CONFIG)).toBe(false);
      expect(isExcluded(undefined, DEFAULT_CONFIG)).toBe(false);
    });

    it('returns false when config is missing or null', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/x/.claude/y', null)).toBe(false);
      expect(isExcluded('/x/.claude/y', undefined)).toBe(false);
      expect(isExcluded('/x/.claude/y', {})).toBe(false);
    });

    it('returns false when both segment and basename arrays are empty', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/x/.claude/y', {
        excluded_path_segments: [],
        excluded_basenames: [],
      })).toBe(false);
    });

    it('ignores non-string entries in config arrays', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('/home/user/.claude/x', {
        excluded_path_segments: [42, null, '/.claude/', undefined],
        excluded_basenames: [42, 'MEMORY.md'],
      })).toBe(true);
    });

    it('filePath with only backslashes gets normalized', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded('C:\\.git\\HEAD', DEFAULT_CONFIG)).toBe(true);
    });

    it('non-string filePath returns false safely', () => {
      const { isExcluded } = loadFresh();
      expect(isExcluded(42, DEFAULT_CONFIG)).toBe(false);
      expect(isExcluded({}, DEFAULT_CONFIG)).toBe(false);
    });
  });
});
