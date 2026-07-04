import { describe, it, expect } from 'vitest';
import { reloadOrStartPm2 } from '../src/cli/pm2.js';
import type { HostConnection, ExecResult } from '../src/cli/types.js';

const conn: HostConnection = { host: 'h', port: 22, user: 'u', keyPath: 'k', certPath: 'c' };

function fakeExec(jlist: string, describe = 'status online') {
  const calls: string[] = [];
  const exec = async (_c: HostConnection, command: string): Promise<ExecResult> => {
    calls.push(command);
    if (command.includes('pm2 jlist')) return { code: 0, stdout: jlist, stderr: '' };
    if (command.includes('pm2 describe')) return { code: 0, stdout: describe, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { exec, calls };
}

describe('reloadOrStartPm2', () => {
  it('reloads when the app exists (zero-downtime)', async () => {
    const h = fakeExec(JSON.stringify([{ name: 'www', pm2_env: { status: 'online' } }]));
    await reloadOrStartPm2(h.exec, conn, { remotePath: 'app', app: 'www', log: () => {}, settleMs: 0 });
    expect(h.calls.some(c => c.includes('pm2 reload ecosystem.config.js'))).toBe(true);
    expect(h.calls.some(c => c.includes('pm2 save'))).toBe(true);
  });

  it('starts when the app does not exist', async () => {
    const h = fakeExec('[]');
    await reloadOrStartPm2(h.exec, conn, { remotePath: 'app', app: 'www', log: () => {}, settleMs: 0 });
    expect(h.calls.some(c => c.includes('pm2 start ecosystem.config.js'))).toBe(true);
  });

  it('throws when the app is not online after reload', async () => {
    const h = fakeExec('[]', 'status errored');
    await expect(reloadOrStartPm2(h.exec, conn, { remotePath: 'app', app: 'www', log: () => {}, settleMs: 0 }))
      .rejects.toThrow(/not running/);
  });

  it('polls pm2 describe until online, succeeding as soon as it reports online', async () => {
    let describeCalls = 0;
    const exec = async (_c: HostConnection, command: string): Promise<ExecResult> => {
      if (command.includes('pm2 jlist')) return { code: 0, stdout: JSON.stringify([{ name: 'www' }]), stderr: '' };
      if (command.includes('pm2 describe')) {
        describeCalls++;
        // offline on first probe, online on the second
        return { code: 0, stdout: describeCalls >= 2 ? 'status online' : 'status launching', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    await reloadOrStartPm2(exec, conn, { remotePath: 'app', app: 'www', log: () => {}, settleMs: 2000 });
    expect(describeCalls).toBeGreaterThanOrEqual(2); // polled, not one-shot
  });

  it('throws if never online within the ceiling', async () => {
    const exec = async (_c: HostConnection, command: string): Promise<ExecResult> => {
      if (command.includes('pm2 jlist')) return { code: 0, stdout: JSON.stringify([{ name: 'www' }]), stderr: '' };
      if (command.includes('pm2 describe')) return { code: 0, stdout: 'status errored', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(reloadOrStartPm2(exec, conn, { remotePath: 'app', app: 'www', log: () => {}, settleMs: 0 }))
      .rejects.toThrow(/not running/);
  });

  it('guarantees one final probe at/after the deadline — an app coming online in that boundary window still succeeds (I3)', async () => {
    // Uses a small positive settleMs (the poll interval is a fixed 250ms) so
    // there is a real "boundary window": the probe that straddles the
    // deadline. The fake reports offline until real elapsed time has passed
    // the ceiling, then online — simulating an app that only becomes ready
    // in the (last-pre-deadline-probe, ceiling] window.
    //
    // Pre-fix, the loop checked `Date.now() >= deadline` immediately after a
    // FAILED probe and broke before taking another one — so the probe that
    // lands at/after the deadline never happened, and this scenario would
    // throw. Capturing `pastDeadline` before each probe (this fix) guarantees
    // the loop always takes one more sample once the deadline has passed,
    // matching (a superset of) the old single end-of-ceiling probe.
    const settleMs = 300;
    const start = Date.now();
    let describeCalls = 0;
    const exec = async (_c: HostConnection, command: string): Promise<ExecResult> => {
      if (command.includes('pm2 jlist')) return { code: 0, stdout: JSON.stringify([{ name: 'www' }]), stderr: '' };
      if (command.includes('pm2 describe')) {
        describeCalls++;
        const elapsed = Date.now() - start;
        return { code: 0, stdout: elapsed >= settleMs ? 'status online' : 'status launching', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(
      reloadOrStartPm2(exec, conn, { remotePath: 'app', app: 'www', log: () => {}, settleMs })
    ).resolves.toBeUndefined();
    expect(describeCalls).toBeGreaterThanOrEqual(2);
  });
});
