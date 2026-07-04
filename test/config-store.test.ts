import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigs, setConfig, getConfig, importConfigFile } from '../src/cli/config-store.js';

const minimal = {
  hosts: ['10.0.0.1'], ssh: { user: 'sysadmin' }, versionFile: 'shared/version',
  static: { localPath: 'public/', remotePath: '/var/www/' },
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'webdeploy-test-')); });

describe('config-store', () => {
  it('returns empty store when no file exists', async () => {
    expect(await loadConfigs(dir)).toEqual({ configs: {} });
  });

  it('round-trips a config and writes the file 0600', async () => {
    await setConfig('prod', minimal as never, dir);
    expect(await getConfig('prod', dir)).toEqual(minimal);
    const mode = statSync(join(dir, 'configs.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('getConfig throws for unknown name', async () => {
    await expect(getConfig('nope', dir)).rejects.toThrow(/not found/);
  });

  it('importConfigFile validates before storing', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ hosts: [] }));
    await expect(importConfigFile('x', bad, dir)).rejects.toThrow(/hosts/);
  });
});
