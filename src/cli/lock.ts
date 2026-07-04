// Path: src/cli/lock.ts
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

function lockFile(configName: string): string {
  return join(tmpdir(), `znvault-webdeploy-${configName}.lock`);
}

function tryCreate(file: string, data: string): boolean {
  try {
    const fd = openSync(file, 'wx');
    writeSync(fd, data);
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export class LockHeldError extends Error {}

export function acquireLock(configName: string): void {
  const file = lockFile(configName);
  const data = JSON.stringify({ pid: process.pid, user: userInfo().username, since: new Date().toISOString(), host: hostname() });

  if (tryCreate(file, data)) return;

  let stale = false;
  try {
    const lock = JSON.parse(readFileSync(file, 'utf-8')) as { pid: number; user: string; since: string };
    try {
      process.kill(lock.pid, 0);
      throw new LockHeldError(`Another deploy is already running (pid ${lock.pid}, user ${lock.user}, since ${lock.since}). Lock: ${file}`);
    } catch (err) {
      if (err instanceof LockHeldError) throw err;
      // Only ESRCH proves the PID is dead. EPERM means alive under another
      // user — the lock must NOT be stolen.
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') stale = true;
      else throw new LockHeldError(`Lock ${file} is held by pid ${lock.pid} (probe: ${(err as Error).message}). Not stealing it.`);
    }
  } catch (err) {
    if (err instanceof LockHeldError) throw err;
    stale = true; // unreadable/corrupt lock file
  }

  if (!stale) throw new LockHeldError(`Lock ${file} exists and could not be verified.`);
  rmSync(file, { force: true });
  if (!tryCreate(file, data)) throw new LockHeldError('Another deploy started simultaneously. Please retry.');
}

export function releaseLock(configName: string): void {
  const file = lockFile(configName);
  try {
    if (existsSync(file)) {
      const lock = JSON.parse(readFileSync(file, 'utf-8')) as { pid: number };
      if (lock.pid === process.pid) rmSync(file, { force: true });
    }
  } catch { /* ignore */ }
}

export function installLockHandlers(configName: string): void {
  process.on('exit', () => releaseLock(configName));
  process.on('SIGINT', () => { releaseLock(configName); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(configName); process.exit(143); });
}
