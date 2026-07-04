import { describe, it, expect } from 'vitest';
import { validateDeployConfig } from '../src/cli/config-validate.js';

const valid = {
  hosts: ['10.0.0.1', '10.0.0.2'],
  ssh: { user: 'sysadmin' },
  versionFile: 'shared/version',
  app: {
    localPath: 'deploy', remotePath: 'app', pm2App: 'www',
    env: { API_KEY: 'alias:webapp/prod/remote-api.key', NODE_ENV: 'production' },
  },
  static: { localPath: 'public/', remotePath: '/var/www/' },
  cdn: { provider: 'cloudflare', zoneId: 'alias:webapp/prod/cloudflare.zoneId', apiToken: 'alias:webapp/prod/cloudflare.token', purge: 'everything' },
};

describe('validateDeployConfig', () => {
  it('accepts a valid config', () => {
    expect(validateDeployConfig(valid)).toEqual([]);
  });

  it('rejects missing hosts / ssh user / versionFile', () => {
    const errs = validateDeployConfig({});
    expect(errs.join(' ')).toMatch(/hosts/);
    expect(errs.join(' ')).toMatch(/ssh\.user/);
    expect(errs.join(' ')).toMatch(/versionFile/);
  });

  it('rejects a literal cdn.apiToken (secret fields must be alias: refs)', () => {
    const bad = { ...valid, cdn: { ...valid.cdn, apiToken: 'z6JrRAWTOKEN' } };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/cdn\.apiToken.*alias:/);
  });

  it('rejects an env value that looks secret but is a raw literal', () => {
    const bad = { ...valid, app: { ...valid.app, env: { API_KEY: 'T18_rawvalue' } } };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/app\.env\.API_KEY/);
  });

  it('allows plain non-secret env values (NODE_ENV=production)', () => {
    expect(validateDeployConfig(valid)).toEqual([]);
  });

  it('rejects cdn: null (must not silently skip the alias-only check)', () => {
    const bad = { ...valid, cdn: null as never };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/cdn must be an object/);
  });

  it('rejects non-object app.env and app.files', () => {
    const badEnv = { ...valid, app: { ...valid.app, env: 42 as unknown } };
    expect(validateDeployConfig(badEnv).join(' ')).toMatch(/app\.env must be an object/);
    const badFiles = { ...valid, app: { ...valid.app, files: 'x' as unknown } };
    expect(validateDeployConfig(badFiles).join(' ')).toMatch(/app\.files must be an object/);
  });

  it('rejects static as non-object', () => {
    const bad = { ...valid, static: 'x' as unknown };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/static must be an object/);
  });

  it('rejects notify as non-object', () => {
    const bad = { ...valid, notify: 42 as unknown };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/notify must be an object/);
  });

  it('rejects notify.helpSync as non-object', () => {
    const bad = { ...valid, notify: { ...valid.cdn, helpSync: 'x' as unknown } };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/notify\.helpSync must be an object/);
  });

  it('rejects static.localPath without a trailing slash', () => {
    const bad = { ...valid, static: { ...valid.static, localPath: 'public' } };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/static\.localPath must end with '\/'/);
  });

  it('rejects static.remotePath without a trailing slash', () => {
    const bad = { ...valid, static: { ...valid.static, remotePath: '/var/www' } };
    expect(validateDeployConfig(bad).join(' ')).toMatch(/static\.remotePath must end with '\/'/);
  });
});
