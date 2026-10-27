import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicationFixture } from './fixtures/publication.js';
import { registerAllCommands } from '../src/cli/commands/index.js';
import type { CLIPluginContext } from '../src/cli/plugin-types.js';
vi.mock('../src/cli/ssh-cert.js', () => ({
  ensureCertificate: async () => ({
    keyPath: 'key',
    certPath: 'cert',
    certificateExpiresAt: Date.now() + 3600000,
  }),
}));
vi.mock('../src/cli/secret-resolver.js', async (original) => ({
  ...(await original<typeof import('../src/cli/secret-resolver.js')>()),
  resolveConfigSecrets: async (_client: unknown, cfg: unknown) => cfg,
}));
vi.mock('../src/cli/ssh-exec.js', async (original) => ({
  ...(await original<typeof import('../src/cli/ssh-exec.js')>()),
  withSshSession: async (conns: unknown[], fn: (value: unknown[]) => Promise<unknown>) => fn(conns),
}));
vi.mock('../src/cli/run.js', async (original) => ({
  ...(await original<typeof import('../src/cli/run.js')>()),
  runDeploy: async (
    name: string,
    cfg: { hosts: string[] },
    _conns: unknown,
    deps: {
      publication: { rootDir: string; receipt: { build: string; artifact: { artifactSha256: string } } };
    }
  ) => {
    const resultDir = join(deps.publication.rootDir, '.release-artifacts/webdeploy-results');
    rmSync(resultDir, { recursive: true, force: true });
    writeFileSync(resultDir, 'block durable result');
    const { receipt } = deps.publication;
    return {
      config: name,
      build: receipt.build,
      success: true,
      hosts: cfg.hosts.map((host) => ({
        host,
        success: true,
        healthOk: true,
        nginxOk: true,
        healthResults: [],
        artifactVerified: true,
        artifactSha256: receipt.artifact.artifactSha256,
      })),
      warnings: [],
      purge: { ok: true },
      verify: {
        allMatch: true,
        results: cfg.hosts.map((server) => ({ server, actual: receipt.build, match: true })),
      },
    };
  },
}));
let root: string | undefined;
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});
it('exits unsuccessfully when durable result publication fails after successful rollout gates', async () => {
  const f = publicationFixture();
  root = f.root;
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
  const command = new Command().exitOverride();
  registerAllCommands(command, {
    client: {},
    output: { info: () => {}, error: () => {}, success: () => {} },
  } as unknown as CLIPluginContext);
  await command.parseAsync(
    ['run', 'prod', '--receipt', f.receiptPath, '--config-file', f.configFile, '--json'],
    { from: 'user' }
  );
  const summary = JSON.parse(output.at(-1)!);
  expect(process.exitCode).toBe(1);
  expect(summary.success).toBe(false);
  expect(summary.deploymentReceipt).toBeUndefined();
  expect(summary.hosts.every((h: { healthOk: boolean }) => h.healthOk)).toBe(true);
});
