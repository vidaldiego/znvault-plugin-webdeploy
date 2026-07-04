// Path: src/cli/ssh-exec.ts
import { spawn, execSync } from 'node:child_process';
import type { Exec, ExecPipe, ExecResult, HostConnection } from './types.js';

export function sshBaseArgs(conn: HostConnection): string[] {
  return [
    '-p', String(conn.port),
    '-i', conn.keyPath,
    '-o', `CertificateFile=${conn.certPath}`,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'StrictHostKeyChecking=accept-new',
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

export function runRsync(args: string[], onOutput?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('rsync', args);
    child.stdout.on('data', d => onOutput?.(String(d)));
    child.stderr.on('data', d => onOutput?.(String(d)));
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
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
