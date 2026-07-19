import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const debugLogPath = require.resolve('../../src/engine/debug-log');
const canaryPath = require.resolve('../../src/engine/sphere-canary');

let calls;

function loadCanaryWithSpy() {
  delete require.cache[canaryPath];
  delete require.cache[debugLogPath];
  calls = [];
  require.cache[debugLogPath] = {
    id: debugLogPath,
    filename: debugLogPath,
    loaded: true,
    exports: {
      debugLog: (module, message, data) => { calls.push({ module, message, data }); },
      createTimer: () => ({ start() {}, elapsed() {} }),
    },
  };
  return require('../../src/engine/sphere-canary');
}

beforeEach(() => {
  loadCanaryWithSpy();
});

afterEach(() => {
  delete require.cache[canaryPath];
  delete require.cache[debugLogPath];
});

describe('sphere-canary — recordCanary', () => {
  for (const kind of ['fired', 'marker_found', 'marker_malformed', 'node_unresolved']) {
    it(`logs the '${kind}' signal to debug-log under the sphere-canary module`, () => {
      const { recordCanary } = require('../../src/engine/sphere-canary');
      recordCanary(kind, { foo: 'bar' });
      expect(calls).toHaveLength(1);
      expect(calls[0].module).toBe('sphere-canary');
      expect(calls[0].message).toBe(kind);
      expect(calls[0].data).toEqual({ foo: 'bar' });
    });
  }

  it('does not throw on an invalid kind and still logs it marked unknown', () => {
    const { recordCanary } = require('../../src/engine/sphere-canary');
    expect(() => recordCanary('bogus', { foo: 'bar' })).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].module).toBe('sphere-canary');
    expect(calls[0].message).toBe('bogus');
    expect(calls[0].data.unknown_kind).toBe(true);
    expect(calls[0].data.foo).toBe('bar');
  });

  it('does not throw when detail is omitted', () => {
    const { recordCanary } = require('../../src/engine/sphere-canary');
    expect(() => recordCanary('fired')).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe('fired');
  });

  it('does not throw with DEVGUARD_DEBUG unset (real debug-log no-op)', () => {
    // Use the real debug-log to confirm non-blocking behaviour end-to-end.
    delete require.cache[canaryPath];
    delete require.cache[debugLogPath];
    const prev = process.env.DEVGUARD_DEBUG;
    delete process.env.DEVGUARD_DEBUG;
    const { recordCanary } = require('../../src/engine/sphere-canary');
    expect(() => recordCanary('marker_found', { node_id: 'a.js:foo' })).not.toThrow();
    if (prev !== undefined) process.env.DEVGUARD_DEBUG = prev;
  });
});
