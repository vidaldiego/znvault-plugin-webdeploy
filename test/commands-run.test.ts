import { describe, it, expect } from 'vitest';
import { buildSummaryLines, assertTransportSafePaths, prepareResolvedRun } from '../src/cli/commands/run.js';
import { Redactor } from '../src/cli/secret-resolver.js';
import type { CLIPluginContext } from '../src/cli/plugin-types.js';
import type { RunSummary } from '../src/cli/types.js';

const summary: RunSummary = {
  config: 'prod', build: '30412',
  hosts: [
    { host: 'h1', success: true, healthResults: ['✅ nginx: active'], healthOk: true },
    { host: 'h2', success: false, skipped: true, healthResults: [], healthOk: false },
  ],
  purge: { ok: true },
  verify: { allMatch: true, results: [{ server: 'h1', match: true, actual: '30412' }] },
  warnings: ['health check failed on h1'],
  success: false,
};

describe('buildSummaryLines', () => {
  it('renders build, host statuses and warnings', () => {
    const text = buildSummaryLines(summary).join('\n');
    expect(text).toContain('Build: 30412');
    expect(text).toContain('✅ h1');
    expect(text).toContain('⏭️ h2');
    expect(text).toMatch(/⚠️.*health check failed/);
  });
});

describe('assertTransportSafePaths', () => {
  it('does not throw when neither path contains whitespace', () => {
    expect(() => assertTransportSafePaths('/home/user/.ssh/id_ed25519', '/home/user/.ssh/id_ed25519-webdeploy-cert.pub')).not.toThrow();
  });

  it('throws when the key path contains whitespace', () => {
    expect(() => assertTransportSafePaths('/home/my user/.ssh/id_ed25519', '/home/my user/.ssh/id_ed25519-webdeploy-cert.pub'))
      .toThrow(/key path contains whitespace/i);
  });

  it('throws when the cert path contains whitespace', () => {
    expect(() => assertTransportSafePaths('/home/user/.ssh/id_ed25519', '/home/user/.ssh/id_ed25519 cert.pub'))
      .toThrow(/certificate path contains whitespace/i);
  });

  it('throws when the cert path contains a tab', () => {
    expect(() => assertTransportSafePaths('/k/id', '/k/with\ttab-cert.pub')).toThrow(/whitespace|space/i);
  });
});

describe('prepareResolvedRun', () => {
  // prepareResolvedRun must take the redactor from the caller instead of constructing
  // its own (Finding 1) — a client that throws if touched proves resolution never
  // reaches secret/cert lookups for an unknown config, i.e. failure happens before any
  // caller-visible use of the redactor, and the signature accepts a passed-in Redactor.
  const fakeCtx = {
    client: {
      async get() { throw new Error('client.get should not be called for an unknown config'); },
      async post() { throw new Error('client.post should not be called for an unknown config'); },
    },
  } as unknown as CLIPluginContext;

  it('accepts a caller-supplied Redactor and fails fast (before touching vault) for an unknown config', async () => {
    const redactor = new Redactor();
    await expect(prepareResolvedRun(fakeCtx, '__definitely-not-a-configured-webdeploy-target__', redactor))
      .rejects.toThrow(/not found/i);
  });
});
