import { afterEach, expect, it } from 'vitest';
import { writeFileSync, rmSync, symlinkSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { publicationFixture } from './fixtures/publication.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const f = publicationFixture();
  roots.push(f.root);
  return f;
}
it('accepts matching clean publication evidence and rechecks exact local inputs', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const f = fixture();
  const loaded = validatePublicationReceipt({ ...f, operation: 'run' });
  expect(loaded.receipt.artifact.artifactSha256).toBe(f.receipt.artifact.artifactSha256);
  writeFileSync(join(f.root, 'deploy/server.js'), 'changed');
  expect(() => loaded.recheck()).toThrow(/inventory/);
});
it('rejects stale activation but permits read-only inspection; rejects future validation', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const f = fixture();
  f.receipt.validation.validatedAt = new Date(Date.now() - 25 * 3600000).toISOString();
  f.save();
  expect(() => validatePublicationReceipt({ ...f, operation: 'run' })).toThrow(/expired/);
  expect(() => validatePublicationReceipt({ ...f, operation: 'verify' })).not.toThrow();
  f.receipt.validation.validatedAt = new Date(Date.now() + 3600000).toISOString();
  f.save();
  expect(() => validatePublicationReceipt({ ...f, operation: 'verify' })).toThrow(/future/);
});
it('rejects dirty checkout, extra files, symlinks, duplicates and escaping manifest paths', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const f = fixture();
  writeFileSync(join(f.root, 'new-untracked'), 'dirty');
  expect(() => validatePublicationReceipt({ ...f, operation: 'run' })).toThrow(/clean/);
  rmSync(join(f.root, 'new-untracked'));
  writeFileSync(join(f.root, 'deploy/extra'), 'extra');
  expect(() => validatePublicationReceipt({ ...f, operation: 'run' })).toThrow(/inventory/);
  rmSync(join(f.root, 'deploy/extra'));
  symlinkSync('/tmp', join(f.root, 'deploy/link'));
  expect(() => validatePublicationReceipt({ ...f, operation: 'run' })).toThrow(/symlink/);
  rmSync(join(f.root, 'deploy/link'));
  f.receipt.artifact.files.push(f.receipt.artifact.files[0]!);
  f.save();
  expect(() => validatePublicationReceipt({ ...f, operation: 'run' })).toThrow(/duplicate/i);
  f.receipt.artifact.files[0]!.path = 'app/../escape';
  f.save();
  expect(() => validatePublicationReceipt({ ...f, operation: 'run' })).toThrow(/path/);
});
it('rejects manifest files hidden by transfer exclusions', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const f = fixture();
  f.cfg.app.exclude.push('server.js');
  writeFileSync(f.configFile, JSON.stringify(f.cfg));
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'exclude'
  );
  f.receipt.sourceCommit = f.git('rev-parse', 'HEAD');
  const { hash } = await import('./fixtures/publication.js');
  const config = readFileSync(f.configFile);
  f.receipt.configuration[0] = { path: 'webdeploy.config.json', bytes: config.length, sha256: hash(config) };
  f.save();
  expect(() => validatePublicationReceipt({ ...f, operation: 'run' })).toThrow(/excluded/);
});
it('hashes remote installed bytes through stdin and refuses changed, extra or symlinked managed files', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const { verifyRemoteInventory } = await import('../src/cli/remote-inventory.js');
  const f = fixture();
  const loaded = validatePublicationReceipt({ ...f, operation: 'run' });
  mkdirSync(join(f.root, 'app'));
  writeFileSync(join(f.root, 'app/server.js'), 'app bytes');
  mkdirSync(join(f.root, 'remote-static/30542'), { recursive: true });
  writeFileSync(join(f.root, 'remote-static/30542/main.js'), 'public bytes');
  writeFileSync(join(f.root, 'remote-static/version'), '30542');
  writeFileSync(join(f.root, 'remote-static/index.html'), 'new html');
  let payload = '';
  const pipe = async (_c: unknown, command: string, stdin: string) => {
    expect(command).not.toContain('server.js');
    payload = stdin;
    try {
      return {
        code: 0,
        stdout: execFileSync('bash', ['-c', command], {
          cwd: f.root,
          input: stdin,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        stderr: '',
      };
    } catch {
      return { code: 1, stdout: '', stderr: '' };
    }
  };
  const conn = { host: 'h', port: 22, user: 'ops', keyPath: 'key', certPath: 'cert' };
  await verifyRemoteInventory(pipe, conn, loaded);
  expect(payload).toContain('server.js');
  writeFileSync(join(f.root, 'app/server.js'), 'corrupt');
  await expect(verifyRemoteInventory(pipe, conn, loaded)).rejects.toThrow(/inventory/);
  writeFileSync(join(f.root, 'app/server.js'), 'app bytes');
  rmSync(join(f.root, 'app/server.js'));
  await expect(verifyRemoteInventory(pipe, conn, loaded)).rejects.toThrow(/inventory/);
  writeFileSync(join(f.root, 'app/server.js'), 'app bytes');
  writeFileSync(join(f.root, 'app/extra'), 'extra');
  await expect(verifyRemoteInventory(pipe, conn, loaded)).rejects.toThrow(/inventory/);
  rmSync(join(f.root, 'app/extra'));
  mkdirSync(join(f.root, 'app/node_modules'));
  symlinkSync('/tmp', join(f.root, 'app/node_modules/ignored'));
  await verifyRemoteInventory(pipe, conn, loaded);
  symlinkSync('/tmp', join(f.root, 'app/link'));
  await expect(verifyRemoteInventory(pipe, conn, loaded)).rejects.toThrow(/inventory/);
});
it('publishes a private atomic result with exact identity and false gates for unattempted hosts, excluding errors/secrets', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const { writeDeploymentResult } = await import('../src/cli/deployment-result.js');
  const f = fixture();
  const loaded = validatePublicationReceipt({ ...f, operation: 'run' });
  const pointer = writeDeploymentResult(loaded, 'run', new Date().toISOString(), {
    config: 'prod',
    build: '30542',
    hosts: [{ host: 'host1', success: false, healthOk: false, healthResults: [], error: 'super-secret' }],
    warnings: ['secret'],
    success: false,
  });
  expect(statSync(pointer.path).mode & 0o777).toBe(0o600);
  const text = readFileSync(pointer.path, 'utf8');
  expect(text).not.toContain('secret');
  const result = JSON.parse(text);
  expect(result.hosts).toHaveLength(2);
  expect(
    result.hosts.every(
      (h: { artifactVerified: boolean; success: boolean }) => !h.artifactVerified && !h.success
    )
  ).toBe(true);
  expect(result.publicationReceiptSha256).toBe(loaded.publicationReceiptSha256);
  expect(result.gates).toEqual({ health: false, version: false, nginx: false, cdn: false });
});
it('the install command preserves accepted manifests instead of using the manifest-rewriting corepack use', async () => {
  const { installAppDeps } = await import('../src/cli/transfer.js');
  const f = fixture();
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(f.root, 'deploy/package.json'), '{"packageManager":"yarn@4.2.1"}');
  writeFileSync(join(f.root, 'deploy/yarn.lock'), 'lock');
  writeFileSync(
    join(bin, 'corepack'),
    '#!/bin/bash\nif [[ "$1" == use ]]; then printf "rewritten" > package.json; exit 0; fi\nif [[ "$1" != yarn@4.2.1 || "$2" != install || "$3" != --immutable || "$COREPACK_ENABLE_AUTO_PIN" != 0 ]]; then exit 1; fi\nmkdir -p node_modules\n',
    { mode: 0o755 }
  );
  writeFileSync(join(bin, 'yarn'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const before = readFileSync(join(f.root, 'deploy/package.json'), 'utf8');
  await installAppDeps(
    {
      exec: async (_c, command) => {
        try {
          return {
            code: 0,
            stdout: execFileSync('bash', ['-c', command], {
              cwd: f.root,
              env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            }),
            stderr: '',
          };
        } catch {
          return { code: 1, stdout: '', stderr: '' };
        }
      },
      rsync: async () => {},
      log: () => {},
    },
    { host: 'fixture', port: 22, user: 'ops', keyPath: 'k', certPath: 'c' },
    { ...f.cfg, app: { ...f.cfg.app, remotePath: 'deploy', yarnVersion: '4.2.1' } } as never
  );
  expect(readFileSync(join(f.root, 'deploy/package.json'), 'utf8')).toBe(before);
});
it('reserves a caller attempt identity before work and never overwrites its result', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const { beginDeploymentAttempt, writeDeploymentResult } = await import('../src/cli/deployment-result.js');
  const f = fixture();
  const loaded = validatePublicationReceipt({ ...f, operation: 'run' });
  const id = '12345678-1234-4123-8123-123456789abc';
  expect(beginDeploymentAttempt(loaded, id)).toBe(id);
  expect(() => beginDeploymentAttempt(loaded, id)).toThrow();
  const summary = { config: 'prod', build: '30542', hosts: [], warnings: [], success: false };
  const pointer = writeDeploymentResult(loaded, 'run', new Date().toISOString(), summary, id);
  expect(JSON.parse(readFileSync(pointer.path, 'utf8')).attemptId).toBe(id);
  expect(() => writeDeploymentResult(loaded, 'run', new Date().toISOString(), summary, id)).toThrow();
  expect(() => beginDeploymentAttempt(loaded, '../escape')).toThrow();
});
it('rejects an apparently successful summary without exact artifact and all-host gate evidence', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const { writeDeploymentResult } = await import('../src/cli/deployment-result.js');
  const f = fixture();
  const loaded = validatePublicationReceipt({ ...f, operation: 'run' });
  expect(() =>
    writeDeploymentResult(loaded, 'run', new Date().toISOString(), {
      config: 'prod',
      build: '30542',
      success: true,
      hosts: [],
      warnings: [],
    })
  ).toThrow(/complete gates/);
});
it('does not turn a host hash mismatch into successful identity evidence', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const { writeDeploymentResult } = await import('../src/cli/deployment-result.js');
  const f = fixture();
  const loaded = validatePublicationReceipt({ ...f, operation: 'run' });
  const hosts = f.cfg.hosts.map((host) => ({
    host,
    artifactVerified: true,
    artifactSha256: 'f'.repeat(64),
    nginxOk: true,
    success: true,
    healthOk: true,
    healthResults: [],
  }));
  expect(() =>
    writeDeploymentResult(loaded, 'run', new Date().toISOString(), {
      config: 'prod',
      build: '30542',
      success: true,
      hosts,
      warnings: [],
      purge: { ok: true },
      verify: {
        allMatch: true,
        results: f.cfg.hosts.map((server) => ({ server, match: true, actual: '30542' })),
      },
    })
  ).toThrow();
});
it('rejects non-ISO validation times', async () => {
  const { validatePublicationReceipt } = await import('../src/cli/publication.js');
  const f = fixture();
  f.receipt.validation.validatedAt = 'January 1, 2000';
  f.save();
  expect(() => validatePublicationReceipt({ ...f, operation: 'verify' })).toThrow(/date/);
});
it('rejects an app root or ancestor symlink before rsync can write outside the reviewed destination', async () => {
  const { syncAppDir } = await import('../src/cli/transfer.js');
  const f = fixture();
  const outside = join(f.root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep'), 'untouched');
  symlinkSync(outside, join(f.root, 'app'));
  let transfers = 0;
  const deps = {
    exec: async (_conn: unknown, command: string) => {
      try {
        return {
          code: 0,
          stdout: execFileSync('bash', ['-c', command], {
            cwd: f.root,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }),
          stderr: '',
        };
      } catch {
        return { code: 1, stdout: '', stderr: 'unsafe path' };
      }
    },
    rsync: async () => {
      transfers++;
    },
    log: () => {},
  };
  const conn = { host: 'fixture', user: 'ops', port: 22, keyPath: 'key', certPath: 'cert' };
  await expect(syncAppDir(deps, conn, f.cfg as never)).rejects.toThrow();
  await expect(
    syncAppDir(deps, conn, { ...f.cfg, app: { ...f.cfg.app, remotePath: 'app/nested' } } as never)
  ).rejects.toThrow();
  expect(transfers).toBe(0);
  expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('untouched');
});
