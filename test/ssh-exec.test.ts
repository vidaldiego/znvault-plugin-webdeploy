import { describe, it, expect } from 'vitest';
import { sshBaseArgs, sshTransportString, buildRsyncArgs, validateRsyncVersion, sshExec } from '../src/cli/ssh-exec.js';
import type { HostConnection } from '../src/cli/types.js';

const conn: HostConnection = { host: '10.0.0.1', port: 22, user: 'sysadmin', keyPath: '/k/id', certPath: '/k/id-webdeploy-cert.pub' };

describe('sshBaseArgs', () => {
  it('includes port, identity, certificate and batch mode', () => {
    const args = sshBaseArgs(conn);
    expect(args).toEqual([
      '-p', '22', '-i', '/k/id',
      '-o', 'CertificateFile=/k/id-webdeploy-cert.pub',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
    ]);
  });
});

describe('buildRsyncArgs', () => {
  it('builds phase-B style args with delete/delay/filter', () => {
    const args = buildRsyncArgs({
      src: 'public/', dest: 'sysadmin@10.0.0.1:/var/www/',
      transport: sshTransportString(conn),
      checksum: true, delete: true, delayUpdates: true,
      filters: ['- /[0-9][0-9][0-9][0-9][0-9]*/'],
    });
    expect(args[0]).toBe('-azc');
    expect(args).toContain('--delete');
    expect(args).toContain('--delay-updates');
    expect(args).toContain('--delete-delay');
    expect(args).toContain('--filter=- /[0-9][0-9][0-9][0-9][0-9]*/');
    expect(args.at(-2)).toBe('public/');
    expect(args.at(-1)).toBe('sysadmin@10.0.0.1:/var/www/');
  });
});

describe('validateRsyncVersion', () => {
  it('rejects openrsync', () => {
    expect(() => validateRsyncVersion(() => 'openrsync: protocol version 29')).toThrow(/openrsync/);
  });
  it('rejects < 3.1.0 and accepts >= 3.1.0', () => {
    expect(() => validateRsyncVersion(() => 'rsync  version 3.0.9  protocol version 30')).toThrow(/3\.1\.0/);
    expect(() => validateRsyncVersion(() => 'rsync  version 3.4.1  protocol version 32')).not.toThrow();
  });
});

describe('sshExec (local smoke)', () => {
  it('returns non-zero code for unreachable host without throwing', async () => {
    const bad: HostConnection = { ...conn, host: '127.0.0.1', port: 1 };
    const res = await sshExec(bad, 'echo hi');
    expect(res.code).not.toBe(0);
  }, 20_000);
});
