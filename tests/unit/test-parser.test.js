import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseTestOutput } = require('../../src/engine/test-parser');

describe('parseTestOutput', () => {
  it('returns null for empty input', () => {
    expect(parseTestOutput('', '')).toBe(null);
    expect(parseTestOutput(null, null)).toBe(null);
  });

  it('returns null for non-test output', () => {
    expect(parseTestOutput('npm run build completed', '')).toBe(null);
    expect(parseTestOutput('', 'Error: ENOENT file not found')).toBe(null);
  });

  it('parses jest FAIL with suite and test name', () => {
    const stdout = `FAIL  src/my-feature.test.js
  MyTest Suite
    ✕ fails gracefully (42 ms)
    ✓ passes (5 ms)

  ● MyTest Suite › fails gracefully

    Expected value to equal:
      5
    Received:
      6`;

    const result = parseTestOutput(stdout, '');
    expect(result).not.toBe(null);
    expect(result.framework).toBe('jest');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].suite).toBe('MyTest Suite');
    expect(result.failures[0].name).toBe('fails gracefully');
    expect(result.failures[0].file).toBe('src/my-feature.test.js');
  });

  it('parses jest FAIL with multiple failures', () => {
    const stdout = `FAIL  tests/auth.test.js

  ● Auth › login fails
  ● Auth › logout fails`;

    const result = parseTestOutput(stdout, '');
    expect(result.framework).toBe('jest');
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].name).toBe('login fails');
    expect(result.failures[1].name).toBe('logout fails');
  });

  it('parses pytest FAILED output', () => {
    const stdout = `FAILED tests/test_auth.py::TestAuth::test_login - AssertionError
FAILED tests/test_db.py::test_connection - ConnectionError
1 passed, 2 failed`;

    const result = parseTestOutput(stdout, '');
    expect(result).not.toBe(null);
    expect(result.framework).toBe('pytest');
    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].file).toBe('tests/test_auth.py');
    expect(result.failures[0].suite).toBe('TestAuth');
    expect(result.failures[0].name).toBe('test_login');
    expect(result.failures[1].file).toBe('tests/test_db.py');
    expect(result.failures[1].name).toBe('test_connection');
  });

  it('parses vitest-style failure with FAIL marker', () => {
    const stdout = `FAIL  tests/unit/db.test.js
 ✕ inserts change correctly (12ms)
 ✕ handles duplicate (3ms)`;

    const result = parseTestOutput(stdout, '');
    expect(result).not.toBe(null);
    expect(result.failures.length).toBeGreaterThanOrEqual(1);
  });

  it('parses test output from stderr too', () => {
    const result = parseTestOutput('', `FAILED tests/test_x.py::test_foo - Error`);
    expect(result).not.toBe(null);
    expect(result.framework).toBe('pytest');
    expect(result.failures[0].name).toBe('test_foo');
  });

  it('does not include passing tests in failures', () => {
    const stdout = `FAIL  src/app.test.js
  ✕ fails (10 ms)
  ✓ passes (5 ms)`;
    const result = parseTestOutput(stdout, '');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].name).toBe('fails');
  });

  it('does not misparse "FAIL" in error message body', () => {
    const stderr = 'Error: FAIL to connect to database\nConnection refused at port 5432';
    const result = parseTestOutput('', stderr);
    expect(result).toBe(null);
  });

  it('handles large output without crash', () => {
    const bigOutput = 'FAIL  big.test.js\n' + '  ✕ test line (1ms)\n'.repeat(5000);
    const result = parseTestOutput(bigOutput, '');
    expect(result).not.toBe(null);
    expect(result.failures.length).toBeGreaterThan(0);
  });
});
