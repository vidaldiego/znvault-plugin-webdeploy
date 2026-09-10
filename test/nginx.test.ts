import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { applyNginx, assertNginxBaseline, checkNginxListeners, digest, readNginxHash, rollbackNginx, upstreamPorts } from '../src/cli/nginx.js';
import { validateDeployConfig } from '../src/cli/config-validate.js';
import type { HostConnection, ManagedNginx } from '../src/cli/types.js';

const conn: HostConnection = { host: 'test', port: 22, user: 'ops', keyPath: 'unused', certPath: 'unused' };
const spec: ManagedNginx = { localPath: 'ops/nginx/default.conf', remotePath: '/etc/nginx/sites-available/default', enabledPath: '/etc/nginx/sites-enabled/default', upstream: 'myzn' };
const content = 'upstream myzn { least_conn; server 127.0.0.1:3000; keepalive 64; }\n';
const good = (stdout = '') => ({ code: 0, stdout, stderr: '' });

describe('managed nginx contract', () => {
  it('derives every listener, ignoring comments', () => {
    expect(upstreamPorts(content, 'myzn')).toEqual([3000]);
    expect(upstreamPorts(content.replace('keepalive', 'server 127.0.0.1:3001; # comment\nkeepalive'), 'myzn')).toEqual([3000, 3001]);
  });
  it.each(['server api:80', 'server 127.0.0.1:0', 'server 127.0.0.1:65536', 'include upstreams', 'server $backend'])('refuses ambiguous/unsupported backends: %s', statement => {
    expect(() => upstreamPorts(`upstream myzn { ${statement}; }`, 'myzn')).toThrow();
  });
  it('rejects missing/duplicate upstreams and duplicate ports', () => {
    expect(() => upstreamPorts('', 'myzn')).toThrow();
    expect(() => upstreamPorts(content + content, 'myzn')).toThrow();
    expect(() => upstreamPorts(content.replace('keepalive', 'server 127.0.0.1:3000; keepalive'), 'myzn')).toThrow();
  });
  it('rejects unknown drift, accepts exact candidate or explicit predecessor', () => {
    expect(() => assertNginxBaseline(digest(content), content, spec)).not.toThrow();
    expect(() => assertNginxBaseline('a'.repeat(64), content, spec)).toThrow(/drift/);
    expect(() => assertNginxBaseline('a'.repeat(64), content, { ...spec, previousSha256: 'a'.repeat(64) })).not.toThrow();
  });
  it('checks enabled-site identity and syntax; transport failure cannot pass', async () => {
    const exec = vi.fn(async () => good(`${digest(content)}  path`));
    expect(await readNginxHash(exec, conn, spec)).toBe(digest(content));
    expect(exec.mock.calls[0]?.[1]).toContain('readlink -f');
    await expect(readNginxHash(async () => ({ code: 1, stdout: digest(content), stderr: '' }), conn, spec)).rejects.toThrow();
  });
  it('does not replace an already matching file', async () => {
    const pipe = vi.fn(async () => good());
    expect(await applyNginx(async () => good(digest(content)), pipe, conn, spec, content)).toBeUndefined();
    expect(pipe).not.toHaveBeenCalled();
  });
  it('ships a syntax-valid transactional script via stdin with readbacks and rollback', async () => {
    const before = 'a'.repeat(64);
    const pipe = vi.fn(async (_conn, command, script) => {
      expect(command).toBe('sudo -n bash -s');
      execFileSync('/bin/bash', ['-n'], { input: script }); // parse only; no host/file/service action
      expect(script).toContain('trap cleanup EXIT');
      expect(script).toContain('concurrent configuration change');
      expect(script).toContain(before);
      expect(script).toContain(digest(content));
      return good('BACKUP=/etc/nginx/sites-available/default.webdeploy-backup.ABC123\n');
    });
    const result = await applyNginx(async () => good(before), pipe, conn, { ...spec, previousSha256: before }, content);
    expect(result?.before).toBe(before);
    expect(result?.after).toBe(digest(content));
  });
  it('refuses apply failure or missing backup receipt', async () => {
    const baseline = { ...spec, previousSha256: 'a'.repeat(64) };
    await expect(applyNginx(async () => good(baseline.previousSha256), async () => ({ code: 1, stdout: '', stderr: '' }), conn, baseline, content)).rejects.toThrow(/apply failed/);
    await expect(applyNginx(async () => good(baseline.previousSha256), async () => good(), conn, baseline, content)).rejects.toThrow(/backup receipt/);
  });
  it('listener failures are blocking; rollback transport failures are explicit', async () => {
    await expect(checkNginxListeners(async () => ({ code: 1, stdout: '', stderr: '' }), conn, content, spec)).rejects.toThrow(/listener/);
    await expect(rollbackNginx(async () => ({ code: 1, stdout: '', stderr: '' }), conn, spec, { before: 'a'.repeat(64), after: digest(content), backup: `${spec.remotePath}.webdeploy-backup.ABC123` })).rejects.toThrow(/rollback/);
  });
  it('validates target paths and prevents disabling reload', () => {
    const config = { hosts: ['test'], ssh: { user: 'ops' }, versionFile: 'v', app: { localPath: 'app', remotePath: 'app', pm2App: 'www' }, nginx: { config: spec } };
    expect(validateDeployConfig(config)).toEqual([]);
    expect(validateDeployConfig({ ...config, nginx: { config: { ...spec, remotePath: '/etc/passwd' } } }).join(' ')).toMatch(/Invalid/);
    expect(validateDeployConfig({ ...config, nginx: { config: spec, reload: false } }).join(' ')).toMatch(/reload/);
  });
});
