import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyNginx, digest } from '../src/cli/nginx.js';
import type { HostConnection } from '../src/cli/types.js';

const conn: HostConnection = { host: 'fixture', user: 'test', port: 22, keyPath: 'unused', certPath: 'unused' };
const old = 'upstream myzn { server 127.0.0.1:3000; }\n';
const next = 'upstream myzn { least_conn; server 127.0.0.1:3000; }\n';

describe('nginx transaction in a disposable filesystem (no sudo/service calls)', () => {
  it.each(['success', 'syntax', 'reload', 'concurrent'] as const)('%s', async mode => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'webdeploy-nginx-test-')));
    mkdirSync(join(dir, 'sites-available')); mkdirSync(join(dir, 'sites-enabled'));
    const target = join(dir, 'sites-available/default');
    writeFileSync(target, old);
    symlinkSync(target, join(dir, 'sites-enabled/default'));
    try {
      const spec = { localPath: 'unused', remotePath: '/etc/nginx/sites-available/default', enabledPath: '/etc/nginx/sites-enabled/default', upstream: 'myzn', previousSha256: digest(old) };
      const call = applyNginx(async () => ({ code: 0, stdout: digest(old), stderr: '' }), async (_conn, _command, script) => {
        // Adapt Linux sha256sum/base64 flags on macOS, and stub only service
        // effects. The transaction's actual cp/mv/readbacks/traps run in /tmp.
        const helpers = `
sha256sum() { shasum -a 256 "$@"; }
nginx() { if [ '${mode}' = syntax ] && grep -q least_conn '${target}'; then return 1; fi; }
systemctl() {
 if [ "$1" = reload ] && grep -q least_conn '${target}'; then
   if [ '${mode}' = concurrent ]; then printf 'external-change' > '${target}'; return 1; fi
   if [ '${mode}' = reload ]; then return 1; fi
 fi
 return 0
}
`;
        const adapted = script.replaceAll('/etc/nginx/', `${dir}/`);
        const result = spawnSync('/bin/bash', ['-c', helpers + adapted], { encoding: 'utf8' });
        return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      }, conn, spec, next);
      // The fixture's backup path intentionally fails the production receipt
      // validator on success; file outcomes still prove the shell transaction.
      await expect(call).rejects.toThrow(mode === 'success' ? /backup receipt/ : /apply failed/);
      expect(readFileSync(target, 'utf8')).toBe(mode === 'success' ? next : mode === 'concurrent' ? 'external-change' : old);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
