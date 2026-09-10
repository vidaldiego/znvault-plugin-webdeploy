import { createHash } from 'node:crypto';
import type { Exec, ExecPipe, HostConnection, ManagedNginx } from './types.js';

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export const digest = (content: string) => createHash('sha256').update(content).digest('hex');

export function validateManagedNginx(spec: ManagedNginx): void {
  if (!spec || typeof spec.localPath !== 'string' || !spec.localPath ||
      !/^\/etc\/nginx\/sites-available\/[A-Za-z0-9_.-]+$/.test(spec.remotePath) ||
      !/^\/etc\/nginx\/sites-enabled\/[A-Za-z0-9_.-]+$/.test(spec.enabledPath) ||
      !/^[A-Za-z0-9_]+$/.test(spec.upstream) ||
      (spec.previousSha256 !== undefined && !/^[a-f0-9]{64}$/.test(spec.previousSha256))) {
    throw new Error('Invalid managed nginx config: require localPath, exact sites-available/sites-enabled paths, upstream and optional previousSha256');
  }
}

/** Deliberately bounded contract, not a general nginx parser. Includes/variables in
 * the managed upstream are refused; each backend must be an explicit IPv4 loopback. */
export function upstreamPorts(content: string, name: string): number[] {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('Invalid upstream name');
  const source = content.replace(/#[^\n]*/g, '');
  const blocks = [...source.matchAll(new RegExp(`\\bupstream\\s+${name}\\s*\\{([^{}]*)\\}`, 'g'))];
  if (blocks.length !== 1) throw new Error('Expected exactly one managed nginx upstream');
  const ports: number[] = [];
  for (const statement of blocks[0]![1]!.split(';').map(s => s.trim()).filter(Boolean)) {
    const backend = /^server\s+127\.0\.0\.1:(\d+)$/.exec(statement);
    if (backend) {
      const port = Number(backend[1]);
      if (port < 1 || port > 65535 || ports.includes(port)) throw new Error('Invalid or duplicate nginx port');
      ports.push(port);
    } else if (!/^(least_conn|keepalive\s+\d+)$/.test(statement)) {
      throw new Error('Unsupported managed upstream directive');
    }
  }
  if (!ports.length) throw new Error('Managed nginx upstream has no backends');
  return ports;
}

function identityChecks(spec: ManagedNginx): string {
  return `test -f ${quote(spec.remotePath)} && test ! -L ${quote(spec.remotePath)}\n` +
    `test "$(readlink -f ${quote(spec.enabledPath)})" = ${quote(spec.remotePath)}`;
}

export async function readNginxHash(exec: Exec, conn: HostConnection, spec: ManagedNginx): Promise<string> {
  validateManagedNginx(spec);
  const result = await exec(conn, `set -e\n${identityChecks(spec)}\nsudo -n nginx -t >/dev/null 2>&1\nsudo -n nginx -T 2>/dev/null | grep -Fx ${quote(`# configuration file ${spec.enabledPath}:`)} >/dev/null\nsha256sum ${quote(spec.remotePath)}`);
  const hash = result.stdout.trim().split(/\s/)[0] ?? '';
  if (result.code !== 0 || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`[${conn.host}] nginx identity/syntax/readback failed`);
  return hash;
}

export function assertNginxBaseline(actual: string, content: string, spec: ManagedNginx): void {
  upstreamPorts(content, spec.upstream);
  if (actual !== digest(content) && actual !== spec.previousSha256) {
    throw new Error('nginx drift: installed hash is neither the candidate nor its explicitly approved predecessor');
  }
}

export async function checkNginxListeners(exec: Exec, conn: HostConnection, content: string, spec: ManagedNginx): Promise<void> {
  const ports = upstreamPorts(content, spec.upstream);
  const program = `const net=require('node:net'); Promise.all(${JSON.stringify(ports)}.map(port=>new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port});s.setTimeout(3000);s.once('connect',()=>{s.destroy();resolve()});s.once('timeout',()=>{s.destroy();reject(new Error('timeout'))});s.once('error',reject)}))).catch(()=>{process.exitCode=1})`;
  const result = await exec(conn, `node -e ${quote(program)}`);
  if (result.code !== 0) throw new Error(`[${conn.host}] at least one nginx upstream has no reachable listener`);
}

export interface NginxChange { before: string; after: string; backup: string }

/** Content and script travel only through stdin. The host must already be
 * provisioned; this never installs nginx, creates a site or enables a symlink. */
export async function applyNginx(exec: Exec, pipe: ExecPipe, conn: HostConnection, spec: ManagedNginx, content: string): Promise<NginxChange | undefined> {
  const before = await readNginxHash(exec, conn, spec);
  assertNginxBaseline(before, content, spec);
  const after = digest(content);
  if (before === after) return undefined;
  const script = `set -euo pipefail
target=${quote(spec.remotePath)}
${identityChecks(spec)}
test "$(sha256sum "$target" | cut -d' ' -f1)" = ${quote(before)}
backup=$(mktemp "$target.webdeploy-backup.XXXXXX")
candidate=$(mktemp "$target.webdeploy-candidate.XXXXXX")
cp -p "$target" "$backup"
changed=0
cleanup() {
  code=$?
  trap - EXIT
  if [ "$code" != 0 ] && [ "$changed" = 1 ]; then
    if [ "$(sha256sum "$target" | cut -d' ' -f1)" != ${quote(after)} ]; then
      echo 'nginx rollback refused: concurrent configuration change' >&2; exit 1
    fi
    restore=$(mktemp "$target.webdeploy-restore.XXXXXX")
    cp -p "$backup" "$restore" && mv "$restore" "$target" || { echo 'nginx rollback copy failed' >&2; exit 1; }
    nginx -t >/dev/null 2>&1 && systemctl reload nginx && systemctl is-active --quiet nginx &&
      test "$(sha256sum "$target" | cut -d' ' -f1)" = ${quote(before)} || { echo 'nginx rollback failed' >&2; exit 1; }
  fi
  test ! -f "$candidate" || rm -- "$candidate"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '%s' ${quote(Buffer.from(content).toString('base64'))} | base64 -d > "$candidate"
chmod 644 "$candidate"
test "$(sha256sum "$candidate" | cut -d' ' -f1)" = ${quote(after)}
test "$(sha256sum "$target" | cut -d' ' -f1)" = ${quote(before)}
mv "$candidate" "$target"
changed=1
nginx -t >/dev/null 2>&1
systemctl reload nginx
systemctl is-active --quiet nginx
test "$(sha256sum "$target" | cut -d' ' -f1)" = ${quote(after)}
printf 'BACKUP=%s\\n' "$backup"
`;
  const result = await pipe(conn, 'sudo -n bash -s', script);
  if (result.code !== 0) throw new Error(`[${conn.host}] managed nginx apply failed; inspect rollback outcome before retrying`);
  const backup = result.stdout.trim().match(/^BACKUP=(\/etc\/nginx\/sites-available\/[A-Za-z0-9_.-]+\.webdeploy-backup\.[A-Za-z0-9]+)$/m)?.[1];
  if (!backup?.startsWith(`${spec.remotePath}.webdeploy-backup.`)) throw new Error('Missing nginx backup receipt; stop for recovery');
  return { before, after, backup };
}

export async function rollbackNginx(exec: Exec, conn: HostConnection, spec: ManagedNginx, change: NginxChange): Promise<void> {
  const result = await exec(conn, `sudo -n bash -c ${quote(`set -euo pipefail
${identityChecks(spec)}
test "$(sha256sum ${quote(spec.remotePath)} | cut -d' ' -f1)" = ${quote(change.after)}
test "$(sha256sum ${quote(change.backup)} | cut -d' ' -f1)" = ${quote(change.before)}
restore=$(mktemp ${quote(`${spec.remotePath}.webdeploy-restore.XXXXXX`)})
cp -p ${quote(change.backup)} "$restore"
mv "$restore" ${quote(spec.remotePath)}
nginx -t >/dev/null 2>&1
systemctl reload nginx
systemctl is-active --quiet nginx
test "$(sha256sum ${quote(spec.remotePath)} | cut -d' ' -f1)" = ${quote(change.before)}`)}`);
  if (result.code !== 0) throw new Error(`[${conn.host}] nginx rollback failed or refused due to drift; manual recovery required`);
}
