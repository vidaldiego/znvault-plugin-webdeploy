import { describe, it, expect } from 'vitest';
import { runDeploy, renderEnvFile } from '../src/cli/run.js';
import type { RunDeps } from '../src/cli/run.js';
import type { ExecResult, HostConnection, WebDeployConfig } from '../src/cli/types.js';
import type { probeVersion } from '../src/cli/http-probe.js';

const fakeProbe: typeof probeVersion = async (_host, _path) => ({ ok: true, status: 200, body: '30412' });

const cfg: WebDeployConfig = {
  hosts: ['10.0.0.1', '10.0.0.2'],
  ssh: { user: 'sysadmin' },
  versionFile: 'shared/version',
  app: { localPath: 'deploy', remotePath: 'app', pm2App: 'www', env: { API_KEY: 'resolved-secret', NODE_ENV: 'production' } },
  static: { localPath: 'public/', remotePath: '/var/www/' },
  healthChecks: [{ type: 'systemd', unit: 'nginx' }],
  cdn: { provider: 'cloudflare', zoneId: 'Z', apiToken: 'T', purge: 'everything' },
  verify: { versionPath: '/version', hostHeader: 'my.zincapp.com' },
};

const conns: HostConnection[] = cfg.hosts.map(host => ({ host, port: 22, user: 'sysadmin', keyPath: 'k', certPath: 'c' }));

const PM2_OK = JSON.stringify([{ name: 'www', pm2_env: { status: 'online' } }]);

function makeDeps(opts: { failHost?: string; nginxDownOn?: string; redact?: (s: string) => string } = {}) {
  const events: string[] = [];
  const deps: RunDeps = {
    exec: async (conn, command): Promise<ExecResult> => {
      events.push(`exec:${conn.host}:${command.slice(0, 40)}`);
      if (command.includes('pm2 jlist')) return { code: 0, stdout: PM2_OK, stderr: '' };
      if (command.includes('pm2 describe')) return { code: 0, stdout: 'status online', stderr: '' };
      // Batched health script (cfg.healthChecks === [{ type: 'systemd', unit: 'nginx' }]):
      // one printf line, index 0, reflecting whether nginx is active on this host.
      if (command.includes('is-active nginx')) {
        const active = conn.host !== opts.nginxDownOn;
        return { code: 0, stdout: active ? '0|OK|active' : '0|FAIL|inactive', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    pipe: async (conn, command) => { events.push(`pipe:${conn.host}:${command.slice(0, 30)}`); return { code: 0, stdout: '', stderr: '' }; },
    rsync: async args => {
      const dest = args.at(-1) ?? '';
      if (opts.failHost && dest.includes(opts.failHost)) throw new Error('rsync boom');
      events.push(`rsync:${dest}`);
    },
    fetchImpl: (async (url: string | URL | Request) => {
      events.push(`fetch:${String(url)}`);
      return new Response('30412', { status: 200 });
    }) as typeof fetch,
    log: () => {},
    readVersionFile: () => '30412\n',
    sleep: async () => { events.push('sleep'); },
    pm2SettleMs: 0,
    redact: opts.redact ?? (s => s),
    probeVersion: fakeProbe,
  };
  return { deps, events };
}

describe('runDeploy', () => {
  it('deploys hosts in order, purges, verifies, cleans up — success', async () => {
    const { deps, events } = makeDeps();
    const summary = await runDeploy('prod', cfg, conns, deps);
    expect(summary.success).toBe(true);
    expect(summary.build).toBe('30412');
    expect(summary.hosts.map(h => h.success)).toEqual([true, true]);
    expect(events.some(e => e.startsWith('fetch:https://api.cloudflare.com'))).toBe(true);
    // host 1 fully deployed before host 2 starts
    const firstH2 = events.findIndex(e => e.includes('10.0.0.2'));
    const lastH1Deploy = events.findIndex(e => e.startsWith('rsync') && e.includes('10.0.0.1:/var/www/'));
    expect(lastH1Deploy).toBeLessThan(firstH2);
  });

  it('aborts remaining hosts when a deploy fails, and exits unsuccessful', async () => {
    const { deps } = makeDeps({ failHost: '10.0.0.1' });
    const summary = await runDeploy('prod', cfg, conns, deps);
    expect(summary.success).toBe(false);
    expect(summary.hosts[0]?.success).toBe(false);
    expect(summary.hosts[1]?.skipped).toBe(true);
  });

  it('gate failure on host 1 skips host 2 but host 1 stays deployed (warning)', async () => {
    const { deps } = makeDeps({ nginxDownOn: '10.0.0.1' });
    const summary = await runDeploy('prod', cfg, conns, deps);
    expect(summary.hosts[0]?.success).toBe(true);
    expect(summary.hosts[0]?.healthOk).toBe(false);
    expect(summary.hosts[1]?.skipped).toBe(true);
    expect(summary.success).toBe(false); // a skip means not all hosts deployed
    expect(summary.warnings.join(' ')).toMatch(/health/i);
  });

  it('renders the env file via stdin pipe with resolved values', async () => {
    const { deps, events } = makeDeps();
    await runDeploy('prod', cfg, conns, deps);
    expect(events.some(e => e.startsWith('pipe:10.0.0.1'))).toBe(true);
  });

  it('applies redact() to the webhook body so a secret in a host error never reaches the POST', async () => {
    const SECRET = 'super-secret-token-xyz';
    const webhookCfg: WebDeployConfig = { ...cfg, notify: { webhook: 'https://hooks.example/webhook' } };
    let capturedBody = '';
    const { deps } = makeDeps({
      failHost: '10.0.0.1',
      redact: s => s.split(SECRET).join('[REDACTED]'),
    });
    // Simulate a host error that embeds a registered secret value.
    deps.exec = async (conn, command): Promise<ExecResult> => {
      if (command.slice(0, 5) === 'mkdir' && conn.host === '10.0.0.1') {
        throw new Error(`boom: ${SECRET}`);
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    deps.rsync = async () => { throw new Error(`rsync failed with token ${SECRET}`); };
    deps.fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('hooks.example')) capturedBody = String(init?.body);
      return new Response('30412', { status: 200 });
    }) as typeof fetch;

    await runDeploy('prod', webhookCfg, conns, deps);

    expect(capturedBody).not.toContain(SECRET);
    expect(capturedBody).toContain('[REDACTED]');
  });
});

describe('nginx reload gating', () => {
  // Single host, no `static`, no health checks — isolates the reload decision
  // from the rest of the pipeline.
  const noStaticCfg: WebDeployConfig = {
    hosts: ['10.0.0.1'],
    ssh: { user: 'sysadmin' },
    versionFile: 'shared/version',
    app: { localPath: 'deploy', remotePath: 'app', pm2App: 'www' },
  };
  const singleConn: HostConnection[] = [{ host: '10.0.0.1', port: 22, user: 'sysadmin', keyPath: 'k', certPath: 'c' }];

  function makeSimpleDeps() {
    const execCommands: string[] = [];
    const deps: RunDeps = {
      exec: async (_conn, command): Promise<ExecResult> => {
        execCommands.push(command);
        if (command.includes('pm2 jlist')) return { code: 0, stdout: PM2_OK, stderr: '' };
        if (command.includes('pm2 describe')) return { code: 0, stdout: 'status online', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      pipe: async () => ({ code: 0, stdout: '', stderr: '' }),
      rsync: async () => {},
      fetchImpl: (async () => new Response('', { status: 200 })) as typeof fetch,
      log: () => {},
      readVersionFile: () => '30412\n',
      sleep: async () => {},
      pm2SettleMs: 0,
      redact: s => s,
      probeVersion: fakeProbe,
    };
    return { deps, execCommands };
  }

  it('does NOT reload nginx when there is no `static` and no explicit nginx.reload', async () => {
    const { deps, execCommands } = makeSimpleDeps();
    await runDeploy('prod', noStaticCfg, singleConn, deps);
    expect(execCommands.some(c => c.includes('nginx -s reload'))).toBe(false);
  });

  it('reloads nginx when nginx.reload is explicitly true, even without `static`', async () => {
    const { deps, execCommands } = makeSimpleDeps();
    const withExplicitReload: WebDeployConfig = { ...noStaticCfg, nginx: { reload: true } };
    await runDeploy('prod', withExplicitReload, singleConn, deps);
    expect(execCommands.some(c => c.includes('nginx -s reload'))).toBe(true);
  });

  it('still reloads nginx by default when `static` is present', async () => {
    const { deps, execCommands } = makeSimpleDeps();
    const withStatic: WebDeployConfig = { ...noStaticCfg, static: { localPath: 'public/', remotePath: '/var/www/' } };
    await runDeploy('prod', withStatic, singleConn, deps);
    expect(execCommands.some(c => c.includes('nginx -s reload'))).toBe(true);
  });

  it('does not reload when nginx.reload is explicitly false, even with `static`', async () => {
    const { deps, execCommands } = makeSimpleDeps();
    const withStaticNoReload: WebDeployConfig = {
      ...noStaticCfg,
      static: { localPath: 'public/', remotePath: '/var/www/' },
      nginx: { reload: false },
    };
    await runDeploy('prod', withStaticNoReload, singleConn, deps);
    expect(execCommands.some(c => c.includes('nginx -s reload'))).toBe(false);
  });
});

describe('renderEnvFile', () => {
  it('throws a clear error naming the key (never the value) when a value contains a newline', () => {
    expect(() => renderEnvFile({ K: 'a\nb', OTHER: 'fine' })).toThrow(/K/);
    let message = '';
    try {
      renderEnvFile({ K: 'a\nb' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain('a\nb');
  });

  it('renders normally when no value contains a newline', () => {
    expect(renderEnvFile({ A: '1', B: 'two' })).toBe('A=1\nB=two\n');
  });
});
