// Path: src/cli/ssh-exec.ts
import { spawn, execSync, execFileSync } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Exec, ExecPipe, ExecResult, HostConnection, TransferStats } from './types.js';

export function sshBaseArgs(conn: HostConnection): string[] {
  if (conn.certificateExpiresAt !== undefined && Date.now() >= conn.certificateExpiresAt) throw new Error('SSH certificate authorization expired');
  return [
    '-p', String(conn.port),
    '-i', conn.keyPath,
    '-o', `CertificateFile=${conn.certPath}`,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ControlMaster=${conn.controlPath ? 'auto' : 'no'}`,
    '-o', `ControlPath=${conn.controlPath ?? 'none'}`,
    '-o', `ControlPersist=${conn.controlPath ? '60' : 'no'}`,
  ];
}

/** The -e transport string for rsync. */
export function sshTransportString(conn: HostConnection): string {
  return `ssh ${sshBaseArgs(conn).join(' ')}`;
}

function runSsh(conn: HostConnection, command: string, stdin?: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshBaseArgs(conn), `${conn.user}@${conn.host}`, command]);
    // A dead child mid-write emits EPIPE on stdin's own emitter; swallow it —
    // the 'close' handler already reports the failure via the exit code.
    child.stdin.on('error', () => {});
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += String(d); });
    child.stderr.on('data', d => { stderr += String(d); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

export const sshExec: Exec = (conn, command) => runSsh(conn, command);
export const sshPipe: ExecPipe = (conn, command, stdin) => runSsh(conn, command, stdin);

export async function execOrThrow(exec: Exec, conn: HostConnection, command: string, label: string): Promise<string> {
  const res = await exec(conn, command);
  if (res.code !== 0) throw new Error(`[${conn.host}] ${label} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout;
}

export interface RsyncOpts {
  src: string;
  dest: string;
  transport: string;
  checksum?: boolean;
  delete?: boolean;
  delayUpdates?: boolean;
  filters?: string[];
  excludes?: string[];
}

export function buildRsyncArgs(opts: RsyncOpts): string[] {
  const args: string[] = [opts.checksum ? '-azc' : '-az', '--info=stats2'];
  if (opts.delete) args.push('--delete');
  if (opts.delayUpdates) args.push('--delay-updates', '--delete-delay');
  for (const f of opts.filters ?? []) args.push(`--filter=${f}`);
  for (const e of opts.excludes ?? []) args.push(`--exclude=${e}`);
  args.push('-e', opts.transport, opts.src, opts.dest);
  return args;
}

export function runRsync(args: string[], onOutput?: (line: string) => void): Promise<TransferStats> {
  return new Promise((resolve, reject) => {
    const child = spawn('rsync', args, {env: {...process.env, LC_ALL: 'C'}});
    let statsOutput = '';
    child.stdout.on('data', d => { statsOutput = (statsOutput + String(d)).slice(-65536); onOutput?.(String(d)); });
    child.stderr.on('data', d => onOutput?.(String(d)));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(parseRsyncStats(statsOutput));
      else reject(new Error(`rsync failed with exit code ${code}`));
    });
  });
}

export function validateRsyncVersion(runner: (cmd: string) => string = cmd => execSync(cmd, { encoding: 'utf-8' })): void {
  let output: string;
  try {
    output = runner('rsync --version');
  } catch {
    throw new Error('rsync not found on PATH. Install it with: brew install rsync');
  }
  if (output.includes('openrsync')) {
    throw new Error('macOS built-in openrsync is not supported. Install GNU rsync: brew install rsync');
  }
  const match = output.match(/rsync\s+version\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not parse rsync version from: ${output.split('\n')[0]}`);
  const major = parseInt(match[1] ?? '0', 10);
  const minor = parseInt(match[2] ?? '0', 10);
  if (major < 3 || (major === 3 && minor < 1)) {
    throw new Error(`rsync ${match[1]}.${match[2]}.${match[3]} found, but >= 3.1.0 is required. Upgrade: brew install rsync`);
  }
}

/** Own masters and sockets for exactly this invocation. No user SSH-config
 * master may be reused; cleanup runs on normal completion, exceptions and exit.
 * SIGKILL cannot run cleanup, so idle masters also have a short idle timeout. */
export async function withSshSession<T>(
  conns: HostConnection[], fn: (connections: HostConnection[]) => Promise<T>,
  options: { close?: (binary: string, args: string[]) => void; maxDurationMs?: number } = {}
): Promise<T> {
  // Short Unix socket paths also work on macOS (104-byte sockaddr_un limit).
  const dir = mkdtempSync('/tmp/zw-');
  chmodSync(dir, 0o700);
  const deadline = Math.min(Date.now() + (options.maxDurationMs ?? 60 * 60_000), ...conns.map(c => c.certificateExpiresAt ?? Infinity));
  const scoped = conns.map((c, index) => ({ ...c, controlPath: join(dir, `h${index}`), certificateExpiresAt: deadline }));
  const close = options.close ?? ((binary, args) => { execFileSync(binary, args, { stdio: 'ignore', timeout: 5000 }); });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const c of scoped) {
      try { close('ssh', ['-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', `ControlPath=${c.controlPath}`, '-p', String(c.port), '-O', 'exit', `${c.user}@${c.host}`]); } catch { /* absent/dead master */ }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  const expire = setTimeout(cleanup, Math.max(1, deadline - Date.now()));
  expire.unref();
  const signals = new Map<NodeJS.Signals, () => void>();
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    const handler = () => { cleanup(); process.exit(code); };
    signals.set(signal, handler); process.once(signal, handler);
  }
  process.once('exit', cleanup);
  try { return await fn(scoped); }
  finally {
    clearTimeout(expire); process.removeListener('exit', cleanup);
    for (const [signal, handler] of signals) process.removeListener(signal, handler);
    cleanup();
  }
}

export function parseRsyncStats(output: string): TransferStats {
  const match = /^Total transferred file size:\s*([0-9,]+) bytes/m.exec(output);
  const transferredBytes = match ? Number(match[1]!.replace(/,/g, '')) : NaN;
  return Number.isSafeInteger(transferredBytes) && transferredBytes >= 0 ? { transferredBytes } : {};
}
