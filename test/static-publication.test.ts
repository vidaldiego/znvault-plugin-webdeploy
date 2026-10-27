import { afterEach, expect, it } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { publicationFixture } from './fixtures/publication.js';
import { validatePublicationReceipt } from '../src/cli/publication.js';
import { verifyRemoteInventory } from '../src/cli/remote-inventory.js';
import { permissionSessionScript, runPermissionProcess } from '../src/cli/ssh-exec.js';
import type { HostConnection } from '../src/cli/types.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
async function fixture() {
  const f = publicationFixture();
  roots.push(f.root);
  const publication = validatePublicationReceipt({ ...f, operation: 'run' });
  const bin = join(f.root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(f.root, 'app'));
  writeFileSync(join(f.root, 'app/server.js'), 'app bytes');
  mkdirSync(join(f.root, 'remote-static/30541'), { recursive: true });
  writeFileSync(join(f.root, 'remote-static/version'), '30541');
  writeFileSync(join(f.root, 'remote-static/index.html'), 'old html');
  writeFileSync(join(f.root, 'remote-static/30541/keep.js'), 'retained');
  for (const command of ['chown', 'chmod'])
    writeFileSync(join(bin, command), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const conn: HostConnection = {
    host: 'fixture',
    port: 22,
    user: 'ops',
    keyPath: 'unused',
    certPath: 'unused',
  };
  const exec = async (_c: HostConnection, command: string) => {
    try {
      return {
        code: 0,
        stdout: execFileSync('bash', ['-c', command], {
          cwd: f.root,
          env,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        stderr: '',
      };
    } catch {
      return { code: 1, stdout: '', stderr: 'fixture command failed' };
    }
  };
  const pipe = async (_c: HostConnection, command: string, input: string) => {
    try {
      return {
        code: 0,
        stdout: execFileSync('bash', ['-c', command], {
          cwd: f.root,
          env,
          input,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
        stderr: '',
      };
    } catch {
      return { code: 1, stdout: '', stderr: '' };
    }
  };
  let networkTransfers = 0;
  const deps = {
    exec,
    log: () => {},
    permissions: async (c: HostConnection, open: string, restore: string, action: () => Promise<void>) =>
      runPermissionProcess(
        spawn('bash', ['-c', permissionSessionScript(open, restore)], { cwd: f.root, env }),
        c.host,
        action
      ),
    rsync: async (args: string[]) => {
      networkTransfers++;
      const local = [...args];
      const i = local.indexOf('-e');
      local.splice(i, 2);
      local[local.length - 1] = local.at(-1)!.replace('ops@fixture:', '');
      execFileSync('rsync', local, { cwd: f.root, env, stdio: 'pipe' });
    },
  };
  return { ...f, publication, conn, deps, pipe, networkTransfers: () => networkTransfers };
}
it('a staged digest mismatch never promotes live HTML or version', async () => {
  const { stageAndPromoteStatic } = await import('../src/cli/transfer.js');
  const f = await fixture();
  let staging = '';
  await expect(
    stageAndPromoteStatic(f.deps, f.conn, f.cfg as never, '30542', async (root) => {
      staging = root;
      expect(readFileSync(join(f.root, 'remote-static/version'), 'utf8')).toBe('30541');
      writeFileSync(join(root, 'index.html'), 'corrupt');
      await verifyRemoteInventory(f.pipe, f.conn, f.publication, { staticRoot: root });
    })
  ).rejects.toThrow(/inventory/);
  expect(readFileSync(join(f.root, 'remote-static/index.html'), 'utf8')).toBe('old html');
  expect(readFileSync(join(f.root, 'remote-static/version'), 'utf8')).toBe('30541');
  const { existsSync } = await import('node:fs');
  expect(existsSync(staging)).toBe(false);
});
it('hashes staging then promotes remotely once and verifies installed bytes while preserving old builds', async () => {
  const { stageAndPromoteStatic } = await import('../src/cli/transfer.js');
  const f = await fixture();
  const locations: string[] = [];
  await stageAndPromoteStatic(f.deps, f.conn, f.cfg as never, '30542', async (root) => {
    locations.push(root ?? 'installed');
    await verifyRemoteInventory(f.pipe, f.conn, f.publication, root ? { staticRoot: root } : {});
  });
  expect(locations).toHaveLength(2);
  expect(locations[1]).toBe('installed');
  expect(f.networkTransfers()).toBe(1);
  expect(readFileSync(join(f.root, 'remote-static/version'), 'utf8')).toBe('30542');
  expect(readFileSync(join(f.root, 'remote-static/index.html'), 'utf8')).toBe('new html');
  expect(readdirSync(join(f.root, 'remote-static/30541'))).toEqual(['keep.js']);
});
