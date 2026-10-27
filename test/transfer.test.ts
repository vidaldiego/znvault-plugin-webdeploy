import { describe, it, expect } from 'vitest';
import { syncAppDir, installAppDeps, deployStatic, cleanupOldBuilds, shouldInstallRemote } from '../src/cli/transfer.js';
import type { HostConnection, ExecResult, WebDeployConfig } from '../src/cli/types.js';

const conn: HostConnection = { host: '192.0.2.1', port: 22, user: 'ops', keyPath: '/k/id', certPath: '/k/cert' };

const cfg: WebDeployConfig = {
  hosts: ['192.0.2.1'], ssh: { user: 'ops' }, versionFile: 'shared/version',
  app: { localPath: 'deploy', remotePath: 'zincapp-ts', pm2App: 'www', exclude: ['node_modules', '.yarn'], yarnVersion: '4.9.1' },
  static: { localPath: 'public/', remotePath: '/var/www/', retentionCount: 50 },
};

function harness() {
  const execCalls: string[] = [];
  const rsyncCalls: string[][] = [];
  return {
    deps: {
      exec: async (_c: HostConnection, command: string): Promise<ExecResult> => {
        execCalls.push(command);
        return { code: 0, stdout: '', stderr: '' };
      },
      rsync: async (args: string[]) => { rsyncCalls.push(args); },
      permissions: async (_c: HostConnection, open: string, restore: string, action: () => Promise<void>) => { execCalls.push(open); try { await action(); } finally { execCalls.push(restore); } },
      log: () => {},
    },
    execCalls, rsyncCalls,
  };
}

describe('syncAppDir', () => {
  it('rsyncs with excludes but does NOT install deps', async () => {
    const h = harness();
    await syncAppDir(h.deps, conn, cfg);
    const rsync = h.rsyncCalls[0]!;
    expect(rsync).toContain('--exclude=node_modules');
    expect(rsync.at(-2)).toBe('deploy/');
    expect(rsync.at(-1)).toBe('ops@192.0.2.1:zincapp-ts/');
    expect(h.execCalls.some(c => c.includes('install --immutable'))).toBe(false);
  });

  it('does NOT touch yarn.lock (QW4 — the touch defeated yarn\'s mtime shortcut)', async () => {
    const h = harness();
    await syncAppDir(h.deps, conn, cfg);
    expect(h.execCalls.some(c => c.includes('touch') && c.includes('yarn.lock'))).toBe(false);
  });

  it('protects rendered files (.env + app.files) from --delete by root-anchored excludes', async () => {
    const h = harness();
    const cfgWithFiles: WebDeployConfig = {
      ...cfg,
      app: { ...cfg.app!, files: { '.yarnrc.yml': 'content' } },
    };
    await syncAppDir(h.deps, conn, cfgWithFiles);
    const rsync = h.rsyncCalls[0]!;
    expect(rsync).toContain('--exclude=/.env');
    expect(rsync).toContain('--exclude=/.yarnrc.yml');
    // pre-existing excludes must still be present (not clobbered)
    expect(rsync).toContain('--exclude=node_modules');
  });

  it('always excludes /.env even when app.files is absent', async () => {
    const h = harness();
    await syncAppDir(h.deps, conn, cfg);
    expect(h.rsyncCalls[0]).toContain('--exclude=/.env');
  });

  it('excludes the install stamp file (I2 — otherwise --delete wipes it every deploy and QW4 never skips)', async () => {
    const h = harness();
    await syncAppDir(h.deps, conn, cfg);
    expect(h.rsyncCalls[0]).toContain('--exclude=/.deploy-install-stamp');
  });
});

describe('installAppDeps', () => {
  it('pins yarn via corepack then installs without changing the accepted lockfile', async () => {
    const h = harness();
    await installAppDeps(h.deps, conn, cfg);
    expect(h.execCalls.some(c => c.includes('corepack yarn@4.9.1'))).toBe(true);
    expect(h.execCalls.some(c => c.includes('install --immutable'))).toBe(true);
  });
});

describe('shouldInstallRemote', () => {
  it('skips only when hash matches AND node_modules present', () => {
    expect(shouldInstallRemote('h', 'h', true)).toBe(false);
    expect(shouldInstallRemote('h', 'h', false)).toBe(true);
    expect(shouldInstallRemote('h', 'x', true)).toBe(true);
    expect(shouldInstallRemote('h', null, true)).toBe(true);
  });
});

describe('installAppDeps gating', () => {
  const gatingCfg = { hosts: ['h'], ssh: { user: 'u' }, versionFile: 'v',
    app: { localPath: 'deploy', remotePath: 'app', pm2App: 'www', yarnVersion: '4.9.1' },
    static: { localPath: 'public/', remotePath: '/var/www/' } } as unknown as WebDeployConfig;
  const gatingConn = { host: 'h', port: 22, user: 'u', keyPath: 'k', certPath: 'c' };

  it('skips corepack+install when hash matches and node_modules present', async () => {
    const calls: string[] = [];
    const deps = {
      exec: async (_c: HostConnection, command: string): Promise<ExecResult> => {
        calls.push(command);
        if (command.includes('sha256sum')) return { code: 0, stdout: `${'a'.repeat(64)}\n${'a'.repeat(64)}\npresent\n`, stderr: '' };
        if (command.includes('.deploy-install-stamp') && command.includes('cat')) return { code: 0, stdout: 'HASH\n', stderr: '' };
        if (command.includes('test -d') && command.includes('node_modules')) return { code: 0, stdout: 'present\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      rsync: async () => {}, log: () => {},
    };
    await installAppDeps(deps as never, gatingConn as never, gatingCfg);
    expect(calls.some(c => c.includes('install --immutable'))).toBe(false);
  });

  it('installs and writes the stamp when node_modules is absent', async () => {
    const calls: string[] = [];
    const deps = {
      exec: async (_c: HostConnection, command: string): Promise<ExecResult> => {
        calls.push(command);
        if (command.includes('sha256sum')) return { code: 0, stdout: `${'a'.repeat(64)}\n\n`, stderr: '' };
        if (command.includes('.deploy-install-stamp') && command.includes('cat')) return { code: 1, stdout: '', stderr: 'no stamp' };
        if (command.includes('test -d') && command.includes('node_modules')) return { code: 1, stdout: 'absent\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      rsync: async () => {}, log: () => {},
    };
    await installAppDeps(deps as never, gatingConn as never, gatingCfg);
    expect(calls.some(c => c.includes('install --immutable'))).toBe(true);
    expect(calls.some(c => c.includes('.deploy-install-stamp') && (c.includes('>') || c.includes('cat >')))).toBe(true);
  });

  it('stamp round-trip: a written stamp is read back and skips the SECOND install when hash + node_modules are unchanged (B4)', async () => {
    // Captures the `printf %s "<hash>"` stamp write from a first installAppDeps
    // call (which must install, since there's no stamp yet), then feeds that
    // exact captured value back as the `cat` stamp-read stdout for a second
    // call with an unchanged hash and node_modules present — asserting the
    // second call actually SKIPS install. This exercises the write->read
    // round trip end to end, rather than each half in isolation.
    let writtenStamp: string | null = null;
    const callsFirst: string[] = [];
    const firstDeps = {
      exec: async (_c: HostConnection, command: string): Promise<ExecResult> => {
        callsFirst.push(command);
        if (command.includes('sha256sum')) return { code: 0, stdout: `${'a'.repeat(64)}\n\n`, stderr: '' };
        if (command.includes('.deploy-install-stamp') && command.startsWith('cat')) return { code: 1, stdout: '', stderr: 'no stamp' };
        if (command.includes('test -d') && command.includes('node_modules')) return { code: 1, stdout: 'absent\n', stderr: '' };
        if (command.startsWith('printf %s') && command.includes('.deploy-install-stamp')) {
          const m = /printf %s "([^"]*)"/.exec(command);
          writtenStamp = m?.[1] ?? null;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      rsync: async () => {}, log: () => {},
    };
    await installAppDeps(firstDeps as never, gatingConn as never, gatingCfg);
    expect(callsFirst.some(c => c.includes('install --immutable'))).toBe(true);
    expect(writtenStamp).not.toBeNull();

    const callsSecond: string[] = [];
    const secondDeps = {
      exec: async (_c: HostConnection, command: string): Promise<ExecResult> => {
        callsSecond.push(command);
        if (command.includes('sha256sum')) return { code: 0, stdout: `${'a'.repeat(64)}\n${'a'.repeat(64)}\npresent\n`, stderr: '' };
        if (command.includes('.deploy-install-stamp') && command.startsWith('cat')) return { code: 0, stdout: `${writtenStamp}\n`, stderr: '' };
        if (command.includes('test -d') && command.includes('node_modules')) return { code: 0, stdout: 'present\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      rsync: async () => {}, log: () => {},
    };
    await installAppDeps(secondDeps as never, gatingConn as never, gatingCfg);
    expect(callsSecond.some(c => c.includes('install --immutable'))).toBe(false);
  });
});

describe('deployStatic', () => {
  it('runs phase A (new build dir) then phase B (atomic shared) inside scoped permission wraps', async () => {
    const h = harness();
    await deployStatic(h.deps, conn, cfg, '30412');
    expect(h.rsyncCalls).toHaveLength(2);
    expect(h.rsyncCalls[0]!.at(-2)).toBe('public/30412/');
    expect(h.rsyncCalls[0]!.at(-1)).toBe('ops@192.0.2.1:/var/www/30412/');
    expect(h.rsyncCalls[1]).toContain('--delay-updates');
    expect(h.rsyncCalls[1]!.some(a => a.startsWith('--filter='))).toBe(true);
    // mkdir -p precedes the Phase A permission wrap (C1 fix).
    expect(h.execCalls[0]).toContain('mkdir -p /var/www/30412/');
    // Phase A permission wrap: scoped to the new versioned dir, recursive (it's one small new dir).
    expect(h.execCalls[1]).toContain('chown -R ops:www-data /var/www/30412/');

  });

  it('creates the build dir with mkdir -p BEFORE the Phase A chown (C1 — chown on a nonexistent dir fails on fresh builds)', async () => {
    const h = harness();
    await deployStatic(h.deps, conn, cfg, '30412');
    const mkdirIdx = h.execCalls.findIndex(c => c.includes('mkdir -p') && c.includes('/var/www/30412/'));
    const chownIdx = h.execCalls.findIndex(c => c.includes('chown') && c.includes('/var/www/30412/'));
    expect(mkdirIdx).toBeGreaterThanOrEqual(0);
    expect(chownIdx).toBeGreaterThan(mkdirIdx);
  });


});

describe('cleanupOldBuilds', () => {
  it('keeps the newest N numeric dirs', async () => {
    const h = harness();
    await cleanupOldBuilds(h.deps, conn, cfg);
    const cmd = h.execCalls.find(c => c.includes('tail -n +51'));
    expect(cmd).toBeDefined();
    expect(cmd).toContain('sort -rn');
    expect(cmd).toContain('rm -rf');
  });

  it('rejects when the cleanup command exits non-zero (failed rm surfaces, is not masked)', async () => {
    const h = harness();
    h.deps.exec = async (_c: HostConnection, command: string): Promise<ExecResult> => {
      h.execCalls.push(command);
      if (command.includes('while IFS=')) {
        return { code: 123, stdout: '', stderr: 'rm: cannot remove' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(cleanupOldBuilds(h.deps, conn, cfg)).rejects.toThrow(/cleanup old builds/);
  });

  it('scopes the permission wrap to the webroot NON-recursively (QW3 — does not walk every build dir)', async () => {
    const h = harness();
    await cleanupOldBuilds(h.deps, conn, cfg);
    expect(h.execCalls[0]).toContain('sudo chown ops:www-data /var/www/');
    expect(h.execCalls[0]).not.toContain('-R');
    expect(h.execCalls.at(-1)).toContain('chmod g-w /var/www/');
    expect(h.execCalls.at(-1)).not.toContain('-R');
  });
});
