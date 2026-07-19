import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const DEBUG_LOG_PATH = path.resolve(__dirname, '../../src/engine/debug-log.js');

function loadFresh() {
  delete require.cache[require.resolve(DEBUG_LOG_PATH)];
  return require(DEBUG_LOG_PATH);
}

describe('debug-log', () => {
  let stderrSpy;
  const originalDebug = process.env.DEVGUARD_DEBUG;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalDebug === undefined) {
      delete process.env.DEVGUARD_DEBUG;
    } else {
      process.env.DEVGUARD_DEBUG = originalDebug;
    }
  });

  it('DEVGUARD_DEBUG=1 writes module name, message, and ISO timestamp to stderr', () => {
    process.env.DEVGUARD_DEBUG = '1';
    const { debugLog } = loadFresh();

    debugLog('test-module', 'hello world');

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0][0];
    expect(output).toContain('[DevGuard:test-module]');
    expect(output).toContain('hello world');
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  it('DEVGUARD_DEBUG not set → stderr.write not called', () => {
    delete process.env.DEVGUARD_DEBUG;
    const { debugLog } = loadFresh();

    debugLog('mod', 'msg');

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('DEVGUARD_DEBUG=0 → stderr.write not called', () => {
    process.env.DEVGUARD_DEBUG = '0';
    const { debugLog } = loadFresh();

    debugLog('mod', 'msg');

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('data is undefined → no JSON in output', () => {
    process.env.DEVGUARD_DEBUG = '1';
    const { debugLog } = loadFresh();

    debugLog('mod', 'no data');

    const output = stderrSpy.mock.calls[0][0];
    expect(output).not.toContain('{');
    expect(output.trimEnd()).toMatch(/\[DevGuard:mod\] \S+ no data$/);
  });

  it('data is an object → JSON serialized in output', () => {
    process.env.DEVGUARD_DEBUG = '1';
    const { debugLog } = loadFresh();

    debugLog('mod', 'with data', { key: 'value', num: 42 });

    const output = stderrSpy.mock.calls[0][0];
    expect(output).toContain('"key":"value"');
    expect(output).toContain('"num":42');
  });

  it('circular reference in data → no crash, logs [circular] placeholder', () => {
    process.env.DEVGUARD_DEBUG = '1';
    const { debugLog } = loadFresh();

    const obj = {};
    obj.self = obj;

    expect(() => debugLog('mod', 'circular', obj)).not.toThrow();
    const output = stderrSpy.mock.calls[0][0];
    expect(output).toContain('[circular]');
  });

  it('createTimer: elapsed() logs duration in ms', () => {
    process.env.DEVGUARD_DEBUG = '1';
    const { createTimer } = loadFresh();

    const timer = createTimer('perf-module');
    timer.start();
    timer.elapsed('operation done');

    expect(stderrSpy).toHaveBeenCalledOnce();
    const output = stderrSpy.mock.calls[0][0];
    expect(output).toContain('[DevGuard:perf-module]');
    expect(output).toContain('operation done');
    expect(output).toMatch(/\(\d+ms\)/);
  });
});
