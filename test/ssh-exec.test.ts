import { describe, it, expect } from 'vitest';
import { sshBaseArgs, sshTransportString, buildRsyncArgs, validateRsyncVersion, sshExec } from '../src/cli/ssh-exec.js';
import type { HostConnection } from '../src/cli/types.js';

const conn: HostConnection = { host: '192.0.2.1', port: 22, user: 'ops', keyPath: '/k/id', certPath: '/k/id-webdeploy-cert.pub' };

describe('sshBaseArgs', () => {
  it('includes port, identity, certificate and batch mode', () => {
    const args = sshBaseArgs(conn);
    expect(args).toEqual([
      '-p', '22', '-i', '/k/id',
      '-o', 'CertificateFile=/k/id-webdeploy-cert.pub',
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ControlPersist=no',
    ]);
  });
});

describe('buildRsyncArgs', () => {
  it('builds phase-B style args with delete/delay/filter', () => {
    const args = buildRsyncArgs({
      src: 'public/', dest: 'ops@192.0.2.1:/var/www/',
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
    expect(args.at(-1)).toBe('ops@192.0.2.1:/var/www/');
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

describe('invocation SSH transport', () => {
  it('uses private distinct sockets for SSH and rsync and closes only its own masters on failure', async () => {
    const { withSshSession } = await import('../src/cli/ssh-exec.js');
    const { statSync, existsSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const closed: string[] = []; let first = ''; let second = '';
    const close = (_binary: string, args: string[]) => { closed.push(args.join(' ')); };
    await expect(withSshSession([conn], async conns => {
      first = conns[0]!.controlPath!;
      expect(statSync(dirname(first)).mode & 0o777).toBe(0o700);
      expect(sshBaseArgs(conns[0]!)).toContain(`ControlPath=${first}`);
      expect(sshTransportString(conns[0]!)).toContain(`ControlPath=${first}`);
      await withSshSession([conn], async nested => { second = nested[0]!.controlPath!; expect(second).not.toBe(first); }, { close });
      expect(existsSync(dirname(first))).toBe(true);
      throw new Error('failure');
    }, { close })).rejects.toThrow('failure');
    expect(existsSync(dirname(first))).toBe(false);
    expect(existsSync(dirname(second))).toBe(false);
    expect(closed).toHaveLength(2);
    expect(closed.every(c => c.includes('-O exit'))).toBe(true);
  });
  it('disables inherited multiplexing outside its own invocation', () => {
    expect(sshBaseArgs(conn)).toContain('ControlMaster=no');
    expect(sshBaseArgs(conn)).toContain('ControlPath=none');
  });
});

it('parses rsync transferred-byte statistics and leaves unavailable statistics absent', async () => {
  const {parseRsyncStats}=await import('../src/cli/ssh-exec.js');
  expect(parseRsyncStats('Total file size: 99,999 bytes\nTotal transferred file size: 12,345 bytes\nsent 42 bytes')).toEqual({transferredBytes:12345});
  expect(parseRsyncStats('rsync failed')).toEqual({});
});
it('removes transport handlers and expires the invocation before a new SSH call can reuse it',async()=>{
  const {withSshSession}=await import('../src/cli/ssh-exec.js');
  const {existsSync}=await import('node:fs'); const {dirname}=await import('node:path');
  const before=process.listenerCount('SIGTERM');let closed=0;
  await withSshSession([conn],async conns=>{
    expect(process.listenerCount('SIGTERM')).toBe(before+1);
    await new Promise(r=>setTimeout(r,20));
    expect(existsSync(dirname(conns[0]!.controlPath!))).toBe(false);
    expect(()=>sshBaseArgs(conns[0]!)).toThrow(/expired/);
  },{close:()=>{closed++;},maxDurationMs:5});
  expect(closed).toBe(1);expect(process.listenerCount('SIGTERM')).toBe(before);
});
