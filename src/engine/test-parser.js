'use strict';

const JEST_FAIL_RE = /^FAIL\s+(.+)$/m;
const JEST_TEST_RE = /[×✕]\s+(.+?)(?:\s+\(\d+\s*m?s\))?$/gm;
const JEST_SUITE_RE = /●\s+(.+?)\s+›\s+(.+)$/gm;

const VITEST_FAIL_RE = /^(?:\s*[×✕])\s+(.+?)(?:\s+\d+m?s)?$/gm;

const PYTEST_FAILED_RE = /^FAILED\s+(\S+)/gm;

function parseTestOutput(stdout, stderr) {
  const combined = [stdout || '', stderr || ''].join('\n');
  if (!combined.trim()) return null;

  const jestFile = JEST_FAIL_RE.exec(combined);
  if (jestFile) {
    const failures = [];
    const suiteMatches = [...combined.matchAll(JEST_SUITE_RE)];
    if (suiteMatches.length > 0) {
      for (const m of suiteMatches) {
        failures.push({ suite: m[1].trim(), name: m[2].trim(), file: jestFile[1].trim() });
      }
    } else {
      const testMatches = [...combined.matchAll(JEST_TEST_RE)];
      for (const m of testMatches) {
        failures.push({ suite: null, name: m[1].trim(), file: jestFile[1].trim() });
      }
    }
    if (failures.length > 0) {
      return { framework: 'jest', failures };
    }
  }

  const vitestMatches = [...combined.matchAll(VITEST_FAIL_RE)];
  if (vitestMatches.length > 0 && combined.includes('FAIL')) {
    const failures = vitestMatches.map(m => ({ suite: null, name: m[1].trim(), file: null }));
    return { framework: 'vitest', failures };
  }

  PYTEST_FAILED_RE.lastIndex = 0;
  const pytestMatches = [...combined.matchAll(PYTEST_FAILED_RE)];
  if (pytestMatches.length > 0) {
    const failures = pytestMatches.map(m => {
      const parts = m[1].split('::');
      return {
        suite: parts.length > 2 ? parts[1] : null,
        name: parts[parts.length - 1],
        file: parts[0],
      };
    });
    return { framework: 'pytest', failures };
  }

  return null;
}

module.exports = { parseTestOutput };
