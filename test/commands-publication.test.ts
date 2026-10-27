import { afterEach, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { registerAllCommands } from '../src/cli/commands/index.js';
import type { CLIPluginContext } from '../src/cli/plugin-types.js';
import { publicationFixture } from './fixtures/publication.js';
vi.mock('../src/cli/ssh-cert.js', () => ({
  ensureCertificate: vi.fn(async () => {
    throw Error('fixture signing unavailable');
  }),
}));
const roots: string[] = [];
afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
});
function fixture() {
  const f = publicationFixture();
  roots.push(f.root);
  vi.spyOn(process, 'cwd').mockReturnValue(f.root);
  let calls = 0;
  const messages: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => messages.push(String(value)));
  const command = new Command().exitOverride();
  registerAllCommands(command, {
    client: {
      get: async () => {
        calls++;
        throw Error('fixture auth unavailable');
      },
      post: async () => {
        calls++;
        throw Error('fixture auth unavailable');
      },
    },
    output: { info: () => {}, error: () => {}, success: () => {} },
  } as unknown as CLIPluginContext);
  return { ...f, command, messages, calls: () => calls };
}
it('rejects modified receipt inputs before resolving any deployment secret', async () => {
  const f = fixture();
  writeFileSync(join(f.root, 'deploy/server.js'), 'corrupt');
  await f.command.parseAsync(
    ['run', 'prod', '--receipt', f.receiptPath, '--config-file', f.configFile, '--json'],
    { from: 'user' }
  );
  expect(f.calls()).toBe(0);
  expect(process.exitCode).toBe(1);
  expect(JSON.parse(f.messages.at(-1)!).success).toBe(false);
});
it('persists a failed identity-bound receipt for auth failure without copying error output', async () => {
  const f = fixture();
  const id = '12345678-1234-4123-8123-123456789abc';
  await f.command.parseAsync(
    ['run', 'prod', '--receipt', f.receiptPath, '--config-file', f.configFile, '--attempt-id', id, '--json'],
    { from: 'user' }
  );
  const summary = JSON.parse(f.messages.at(-1)!);
  expect(summary.error).toBe('fixture auth unavailable');
  expect(f.calls()).toBe(1);
  expect(summary.success).toBe(false);
  const result = JSON.parse(readFileSync(summary.deploymentReceipt.path, 'utf8'));
  expect(result.attemptId).toBe(id);
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain('auth unavailable');
});
it('rejects purge bypass and invalid attempt identifiers before secrets', async () => {
  const f = fixture();
  await f.command.parseAsync(
    ['run', 'prod', '--receipt', f.receiptPath, '--config-file', f.configFile, '--skip-purge', '--json'],
    { from: 'user' }
  );
  expect(f.calls()).toBe(0);
  expect(JSON.parse(f.messages.at(-1)!).deploymentReceipt).toBeDefined();
});
it('a result-directory symlink prevents publication before any secret or host operation', async () => {
  const f = fixture();
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'fixture'
  );
  f.receipt.sourceCommit = f.git('rev-parse', 'HEAD');
  f.save();
  symlinkSync(outside, join(f.root, '.release-artifacts/webdeploy-results'));
  await f.command.parseAsync(
    ['run', 'prod', '--receipt', f.receiptPath, '--config-file', f.configFile, '--json'],
    { from: 'user' }
  );
  expect(f.calls()).toBe(0);
  expect(JSON.parse(f.messages.at(-1)!).success).toBe(false);
});
