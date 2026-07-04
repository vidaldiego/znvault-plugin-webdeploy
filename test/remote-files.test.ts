import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { writeRemoteFileIfChanged } from '../src/cli/remote-files.js';
import type { HostConnection, ExecResult } from '../src/cli/types.js';

const conn: HostConnection = { host: 'h', port: 22, user: 'u', keyPath: 'k', certPath: 'c' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function harness(remoteContent: string | null) {
  const calls: { kind: string; command: string; stdin?: string }[] = [];
  const exec = async (_c: HostConnection, command: string): Promise<ExecResult> => {
    calls.push({ kind: 'exec', command });
    if (command.startsWith('sha256sum')) {
      return remoteContent === null
        ? { code: 1, stdout: '', stderr: 'No such file' }
        : { code: 0, stdout: `${sha(remoteContent)}  file\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const pipe = async (_c: HostConnection, command: string, stdin: string): Promise<ExecResult> => {
    calls.push({ kind: 'pipe', command, stdin });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, pipe, calls };
}

describe('writeRemoteFileIfChanged', () => {
  it('skips writing when content hash matches', async () => {
    const h = harness('API_KEY=x\n');
    const res = await writeRemoteFileIfChanged(h.exec, h.pipe, conn, 'app/.env', 'API_KEY=x\n');
    expect(res.changed).toBe(false);
    expect(h.calls.filter(c => c.kind === 'pipe')).toHaveLength(0);
  });

  it('writes via stdin when content differs, never in argv', async () => {
    const h = harness('OLD\n');
    const res = await writeRemoteFileIfChanged(h.exec, h.pipe, conn, 'app/.env', 'API_KEY=supersecret\n');
    expect(res.changed).toBe(true);
    const pipeCall = h.calls.find(c => c.kind === 'pipe');
    expect(pipeCall?.stdin).toBe('API_KEY=supersecret\n');
    expect(pipeCall?.command).not.toContain('supersecret');
    expect(pipeCall?.command).toContain('umask 077');
    expect(pipeCall?.command).toContain("app/.env.tmp");
  });

  it('writes when the remote file is missing', async () => {
    const h = harness(null);
    expect((await writeRemoteFileIfChanged(h.exec, h.pipe, conn, 'x', 'y')).changed).toBe(true);
  });
});
