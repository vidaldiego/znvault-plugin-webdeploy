// Path: src/cli/remote-files.ts
import { createHash } from 'node:crypto';
import type { Exec, ExecPipe, HostConnection } from './types.js';

/**
 * Idempotently write a (possibly secret) file on the remote host.
 * Content travels over ssh STDIN — it must never appear in argv, so it can't
 * leak via remote process lists or shell history.
 */
export async function writeRemoteFileIfChanged(
  exec: Exec,
  pipe: ExecPipe,
  conn: HostConnection,
  remotePath: string,
  content: string,
  opts: { mode?: string } = {}
): Promise<{ changed: boolean }> {
  const mode = opts.mode ?? '600';
  const localHash = createHash('sha256').update(content).digest('hex');

  // remotePath comes from operator-authored config (trusted); if its provenance ever widens, shell-quote it.
  const remote = await exec(conn, `sha256sum ${remotePath} 2>/dev/null`);
  if (remote.code === 0 && remote.stdout.trim().startsWith(localHash)) {
    return { changed: false };
  }

  const tmp = `${remotePath}.tmp`;
  const cmd = `umask 077 && cat > ${tmp} && chmod ${mode} ${tmp} && mv ${tmp} ${remotePath}`;
  const res = await pipe(conn, cmd, content);
  if (res.code !== 0) {
    throw new Error(`[${conn.host}] writing ${remotePath} failed (exit ${res.code}): ${res.stderr.trim()}`);
  }
  return { changed: true };
}
