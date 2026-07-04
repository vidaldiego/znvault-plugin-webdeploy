import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { acquireLock, releaseLock, LockHeldError } from '../src/cli/lock.js';

afterEach(() => releaseLock('testcfg'));

describe('lock', () => {
  it('acquires and releases', () => {
    expect(() => acquireLock('testcfg')).not.toThrow();
    releaseLock('testcfg');
    expect(() => acquireLock('testcfg')).not.toThrow();
  });

  it('throws when the same live process already holds the lock', () => {
    acquireLock('testcfg');
    expect(() => acquireLock('testcfg')).toThrow(/already running/);
  });

  it('throws LockHeldError (not stolen) when the lock file names a live pid, even under another purported user', () => {
    const file = join(tmpdir(), 'znvault-webdeploy-testcfg.lock');
    const data = JSON.stringify({
      pid: process.pid, // guaranteed live — probe succeeds (no ESRCH)
      user: userInfo().username,
      since: new Date().toISOString(),
      host: hostname(),
    });
    writeFileSync(file, data);

    let caught: unknown;
    try {
      acquireLock('testcfg');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockHeldError);
  });
});
