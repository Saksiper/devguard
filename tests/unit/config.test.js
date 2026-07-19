import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CONFIG_PATH = path.resolve(__dirname, '../../src/engine/config.js');

function loadFresh() {
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

describe('config', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devguard-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('valid config with all fields returns parsed values', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      [
        'similarity_threshold: 0.75',
        'window_size: 20',
        'min_occurrences: 3',
        'max_entries: 5000',
      ].join('\n'),
    );

    const { loadConfig } = loadFresh();
    const config = loadConfig(tmpDir);

    expect(config.similarity_threshold).toBe(0.75);
    expect(config.window_size).toBe(20);
    expect(config.min_occurrences).toBe(3);
    expect(config.max_entries).toBe(5000);
  });

  it('valid config with partial fields is merged with defaults', () => {
    const { DEFAULTS } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'window_size: 15\n',
    );

    const { loadConfig } = loadFresh();
    const config = loadConfig(tmpDir);

    expect(config.window_size).toBe(15);
    expect(config.similarity_threshold).toBe(DEFAULTS.similarity_threshold);
    expect(config.min_occurrences).toBe(DEFAULTS.min_occurrences);
    expect(config.max_entries).toBe(DEFAULTS.max_entries);
  });

  it('invalid YAML syntax returns DEFAULTS without throwing', () => {
    const { DEFAULTS, loadConfig } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'key: [unclosed bracket\n',
    );

    expect(() => {
      const config = loadConfig(tmpDir);
      expect(config).toEqual(DEFAULTS);
    }).not.toThrow();
  });

  it('sphere_read_resolver_enabled defaults to false (S2.B ships default-OFF)', () => {
    const { DEFAULTS } = loadFresh();
    expect(DEFAULTS.sphere_read_resolver_enabled).toBe(false);
  });

  it('sphere_read_resolver_enabled can be enabled via yaml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'sphere_read_resolver_enabled: true\n',
    );
    const { loadConfig } = loadFresh();
    expect(loadConfig(tmpDir).sphere_read_resolver_enabled).toBe(true);
  });

  it('sphere_read_resolver_enabled rejects non-boolean, falls back to default', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'sphere_read_resolver_enabled: "yes"\n',
    );
    const { loadConfig } = loadFresh();
    expect(loadConfig(tmpDir).sphere_read_resolver_enabled).toBe(false);
  });

  it('intervention_enabled defaults to true (normal usage injects)', () => {
    const { DEFAULTS } = loadFresh();
    expect(DEFAULTS.intervention_enabled).toBe(true);
  });

  it('intervention_enabled can be disabled via yaml (passive A/B mode)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'intervention_enabled: false\n',
    );
    const { loadConfig } = loadFresh();
    expect(loadConfig(tmpDir).intervention_enabled).toBe(false);
  });

  it('intervention_enabled rejects non-boolean, falls back to default (true)', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'intervention_enabled: "no"\n',
    );
    const { loadConfig } = loadFresh();
    expect(loadConfig(tmpDir).intervention_enabled).toBe(true);
  });

  it('missing config file returns DEFAULTS', () => {
    const { DEFAULTS, loadConfig } = loadFresh();
    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULTS);
  });

  it('empty config file returns DEFAULTS', () => {
    const { DEFAULTS, loadConfig } = loadFresh();

    fs.writeFileSync(path.join(tmpDir, 'devguard.config.yaml'), '');

    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULTS);
  });

  it('invalid field values fall back to defaults per field', () => {
    const { DEFAULTS, loadConfig } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      [
        'similarity_threshold: 2',
        'window_size: -1',
        'min_occurrences: 0',
      ].join('\n'),
    );

    const config = loadConfig(tmpDir);

    expect(config.similarity_threshold).toBe(DEFAULTS.similarity_threshold);
    expect(config.window_size).toBe(DEFAULTS.window_size);
    expect(config.min_occurrences).toBe(DEFAULTS.min_occurrences);
  });

  it('monorepo: config in parent directory is found via traversal', () => {
    const { loadConfig } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'window_size: 25\n',
    );

    const subDir = path.join(tmpDir, 'packages', 'app');
    fs.mkdirSync(subDir, { recursive: true });

    const config = loadConfig(subDir);
    expect(config.window_size).toBe(25);
  });

  it('config in projectPath takes priority over parent directory', () => {
    const { loadConfig } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      'window_size: 99\n',
    );

    const subDir = path.join(tmpDir, 'packages', 'app');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(
      path.join(subDir, 'devguard.config.yaml'),
      'window_size: 7\n',
    );

    const config = loadConfig(subDir);
    expect(config.window_size).toBe(7);
  });

  it('unknown keys in config are ignored and known keys are still parsed', () => {
    const { loadConfig } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      [
        'window_size: 8',
        'unknown_future_key: foobar',
        'another_unknown: 42',
      ].join('\n'),
    );

    const config = loadConfig(tmpDir);

    expect(config.window_size).toBe(8);
    expect(config).not.toHaveProperty('unknown_future_key');
    expect(config).not.toHaveProperty('another_unknown');
  });

  it('string values where numbers expected fall back to defaults for those fields', () => {
    const { DEFAULTS, loadConfig } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      [
        'similarity_threshold: "high"',
        'window_size: "ten"',
        'max_entries: 8000',
      ].join('\n'),
    );

    const config = loadConfig(tmpDir);

    expect(config.similarity_threshold).toBe(DEFAULTS.similarity_threshold);
    expect(config.window_size).toBe(DEFAULTS.window_size);
    expect(config.max_entries).toBe(8000);
  });

  it('YAML array input ([1,2,3]) returns DEFAULTS', () => {
    const { DEFAULTS, loadConfig } = loadFresh();

    fs.writeFileSync(
      path.join(tmpDir, 'devguard.config.yaml'),
      '[1, 2, 3]\n',
    );

    const config = loadConfig(tmpDir);
    expect(config).toEqual(DEFAULTS);
  });

  // skipIf Windows — chmod doesn't restrict owner reads on NTFS
  it.skipIf(process.platform === 'win32')('config file with no read permission returns DEFAULTS gracefully', () => {
    const { DEFAULTS, loadConfig } = loadFresh();
    const configFile = path.join(tmpDir, 'devguard.config.yaml');
    fs.writeFileSync(configFile, 'window_size: 50\n');
    fs.chmodSync(configFile, 0o000);

    try {
      const config = loadConfig(tmpDir);
      expect(config).toEqual(DEFAULTS);
    } finally {
      fs.chmodSync(configFile, 0o644);
    }
  });

  describe('noise reduction fields', () => {
    it('exposes default excluded_path_segments as array of known noise dirs', () => {
      const { DEFAULTS } = loadFresh();
      expect(Array.isArray(DEFAULTS.excluded_path_segments)).toBe(true);
      expect(DEFAULTS.excluded_path_segments).toContain('/.claude/');
      expect(DEFAULTS.excluded_path_segments).toContain('/node_modules/');
      expect(DEFAULTS.excluded_path_segments).toContain('/.git/');
      // plans/ intentionally NOT in default — src/plans/ may be real code
      expect(DEFAULTS.excluded_path_segments).not.toContain('/plans/');
    });

    it('exposes default excluded_basenames with MEMORY.md', () => {
      const { DEFAULTS } = loadFresh();
      expect(DEFAULTS.excluded_basenames).toEqual(['MEMORY.md']);
    });

    it('default detection_cooldown_edits is 3', () => {
      const { DEFAULTS } = loadFresh();
      expect(DEFAULTS.detection_cooldown_edits).toBe(3);
    });

    it('user can override excluded_path_segments', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'devguard.config.yaml'),
        [
          'excluded_path_segments:',
          '  - /vendor/',
          '  - /tmp/',
        ].join('\n'),
      );
      const { loadConfig } = loadFresh();
      const config = loadConfig(tmpDir);
      expect(config.excluded_path_segments).toEqual(['/vendor/', '/tmp/']);
    });

    it('user can disable exclusion with empty array', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'devguard.config.yaml'),
        'excluded_path_segments: []\n',
      );
      const { loadConfig } = loadFresh();
      const config = loadConfig(tmpDir);
      expect(config.excluded_path_segments).toEqual([]);
    });

    it('rejects non-array excluded_path_segments and falls back to default', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'devguard.config.yaml'),
        'excluded_path_segments: "not-an-array"\n',
      );
      const { loadConfig, DEFAULTS } = loadFresh();
      const config = loadConfig(tmpDir);
      expect(config.excluded_path_segments).toEqual(DEFAULTS.excluded_path_segments);
    });

    it('rejects non-string entries in excluded_path_segments', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'devguard.config.yaml'),
        [
          'excluded_path_segments:',
          '  - 42',
          '  - /foo/',
        ].join('\n'),
      );
      const { loadConfig, DEFAULTS } = loadFresh();
      const config = loadConfig(tmpDir);
      expect(config.excluded_path_segments).toEqual(DEFAULTS.excluded_path_segments);
    });

    it('accepts detection_cooldown_edits: 0 (disabled)', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'devguard.config.yaml'),
        'detection_cooldown_edits: 0\n',
      );
      const { loadConfig } = loadFresh();
      const config = loadConfig(tmpDir);
      expect(config.detection_cooldown_edits).toBe(0);
    });

    it('rejects negative detection_cooldown_edits', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'devguard.config.yaml'),
        'detection_cooldown_edits: -1\n',
      );
      const { loadConfig } = loadFresh();
      const config = loadConfig(tmpDir);
      expect(config.detection_cooldown_edits).toBe(3); // default
    });

    it('rejects non-integer detection_cooldown_edits', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'devguard.config.yaml'),
        'detection_cooldown_edits: 2.5\n',
      );
      const { loadConfig } = loadFresh();
      const config = loadConfig(tmpDir);
      expect(config.detection_cooldown_edits).toBe(3); // default
    });
  });
});
