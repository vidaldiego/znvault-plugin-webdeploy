import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
// Path: src/cli/transfer.ts
import type { Exec, HostConnection, WebDeployConfig, TransferStats } from './types.js';
import { buildRsyncArgs, execOrThrow, sshTransportString } from './ssh-exec.js';
import { DEFAULT_RETENTION_COUNT } from './constants.js';

export interface TransferDeps {
  exec: Exec;
  rsync(args: string[]): Promise<void | TransferStats>;
  log(line: string): void;
}


export interface RemotePermissionsOpts {
  /**
   * Whether the chown/chmod open+restore recurse into `dir` (`-R`). Defaults
   * to `true` to preserve pre-QW3 behavior for any caller that omits it.
   * Pass `{recursive: false}` to scope the permission change to `dir` itself
   * only — e.g. a webroot with dozens of build dirs where only the top-level
   * shared files are being touched this run.
   */
  recursive?: boolean;
}

export async function withRemotePermissions(
  deps: TransferDeps, conn: HostConnection, dir: string, fn: () => Promise<void>
): Promise<void>;
export async function withRemotePermissions(
  deps: TransferDeps, conn: HostConnection, dir: string, opts: RemotePermissionsOpts, fn: () => Promise<void>
): Promise<void>;
export async function withRemotePermissions(
  deps: TransferDeps, conn: HostConnection, dir: string,
  optsOrFn: RemotePermissionsOpts | (() => Promise<void>), maybeFn?: () => Promise<void>
): Promise<void> {
  const { opts, fn } = typeof optsOrFn === 'function'
    ? { opts: {} as RemotePermissionsOpts, fn: optsOrFn }
    : { opts: optsOrFn, fn: maybeFn! };
  const recursive = opts.recursive ?? true;
  const flag = recursive ? '-R ' : '';

  deps.log(`[${conn.host}] Opening group-write on ${dir}...`);
  let fnError: unknown;
  try {
    await execOrThrow(deps.exec, conn, `sudo chown ${flag}${conn.user}:www-data ${dir}`, 'chown (open)');
    await execOrThrow(deps.exec, conn, `sudo chmod ${flag}g+w ${dir}`, 'chmod (open)');
    await fn();
  } catch (err) {
    fnError = err;
  }
  try {
    deps.log(`[${conn.host}] Restoring permissions on ${dir}...`);
    await execOrThrow(deps.exec, conn, `sudo chown ${flag}www-data:www-data ${dir}`, 'chown (restore)');
    await execOrThrow(deps.exec, conn, `sudo chmod ${flag}g-w ${dir}`, 'chmod (restore)');
  } catch (restoreErr) {
    if (fnError !== undefined) {
      // Original failure wins; the restore failure must not shadow it.
      deps.log(`[${conn.host}] WARNING: permission restore also failed: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`);
    } else {
      throw restoreErr;
    }
  }
  if (fnError !== undefined) throw fnError;
}

const INSTALL_STAMP_FILE = '.deploy-install-stamp';

export async function syncAppDir(deps: TransferDeps, conn: HostConnection, cfg: WebDeployConfig): Promise<void> {
  const app = cfg.app;
  if (!app) return;
  await execOrThrow(deps.exec, conn, `mkdir -p ${app.remotePath}`, 'mkdir app dir');

  deps.log(`[${conn.host}] Syncing app dir ${app.localPath} -> ${app.remotePath}...`);
  // .env, app.files, and the install stamp are all state that lives ONLY on
  // the remote host (rendered directly or written by installAppDeps) and
  // never exist in the local staged tree — so plain --delete would wipe them
  // on every deploy. Anchor each exclude to the transfer root (leading slash)
  // so only the specific file itself is protected, not any same-named path
  // deeper in the tree; this also restores writeRemoteFileIfChanged's
  // sha-compare idempotency (rsync no longer clobbers the file it's about to
  // compare) and keeps QW4's install-skip gate (installAppDeps) from being
  // silently defeated by having its stamp deleted out from under it.
  const excludes = [
    ...(app.exclude ?? []),
    '/.env',
    '/' + INSTALL_STAMP_FILE,
    ...Object.keys(app.files ?? {}).map(f => '/' + f),
  ];
  await deps.rsync(buildRsyncArgs({
    src: `${app.localPath}/`,
    dest: `${conn.user}@${conn.host}:${app.remotePath}/`,
    transport: sshTransportString(conn),
    checksum: true,
    delete: true,
    excludes,
  }));
}

/**
 * Pure gate: install unless the manifest hash matches the remote stamp AND
 * node_modules is already present. Fresh host, wiped node_modules, a changed
 * lockfile, or a missing stamp must ALWAYS install — this may only skip a
 * provably-unnecessary install.
 */
export function shouldInstallRemote(
  localHash: string, remoteStampHash: string | null, nodeModulesPresent: boolean
): boolean {
  return !(localHash === remoteStampHash && nodeModulesPresent);
}

/**
 * Install app dependencies. Runs AFTER the vault-rendered files (.yarnrc.yml
 * with registry tokens, .env) are in place — see run.ts host flow.
 *
 * Hash-gated (QW4): computes a hash-of-hashes over the just-synced
 * package.json + yarn.lock, compares it against a stamp file left by the
 * previous successful install, and skips corepack+yarn install entirely
 * when the hash matches AND node_modules is already present. Any failure
 * while probing (hash/stamp/node_modules) is treated as "must install" —
 * the gate fails safe.
 */
export async function installAppDeps(deps: TransferDeps, conn: HostConnection, cfg: WebDeployConfig): Promise<void> {
  const app = cfg.app;
  if (!app?.yarnVersion) return;

  const stampPath = `${app.remotePath}/${INSTALL_STAMP_FILE}`;

  // One SSH round trip. pipefail prevents a missing manifest from producing a
  // valid hash of empty input and incorrectly authorizing an install skip.
  const probe = await deps.exec(conn, `bash -c ${shellQuote(`set -euo pipefail
hash=$(sha256sum ${app.remotePath}/package.json ${app.remotePath}/yarn.lock | sha256sum | cut -d' ' -f1)
printf '%s\\n' "$hash"
cat ${stampPath} 2>/dev/null || true
printf '\\n'
test ! -d ${app.remotePath}/node_modules || printf 'present\\n'`)} `);
  const lines = probe.stdout.trim().split(/\n/).filter(Boolean);
  const localHash = probe.code === 0 && /^[a-f0-9]{64}$/.test(lines[0] ?? '') ? lines[0]! : '';
  const remoteStampHash = lines[1] ?? null;
  const nodeModulesPresent = lines[2] === 'present';

  if (localHash && !shouldInstallRemote(localHash, remoteStampHash, nodeModulesPresent)) {
    deps.log(`[${conn.host}] deps unchanged — skipping install (QW4)`);
    return;
  }

  deps.log(`[${conn.host}] Pinning yarn@${app.yarnVersion} and installing immutably...`);
  await execOrThrow(deps.exec, conn, `cd ${app.remotePath} && corepack use yarn@${app.yarnVersion}`, 'corepack use');
  // The staged lockfile is part of the accepted web artifact. A mutable
  // install can silently rewrite it on one site, leaving two deployments
  // with the same visible build number but different dependency lineages.
  // Yarn's immutable mode makes that drift a hard deploy failure.
  await execOrThrow(
    deps.exec,
    conn,
    `cd ${app.remotePath} && yarn install --immutable`,
    'yarn install --immutable'
  );
  if (localHash) await execOrThrow(deps.exec, conn, `printf %s "${localHash}" > ${stampPath}`, 'write install stamp');
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Enumerate only top-level shared entries. Numeric build directories are never
 * descended into, including short historical build numbers. Reject links before
 * any recursive ownership operation; rsync needs ownership for nested mtimes. */
export function sharedPermissionsScript(dir: string, user: string, restore: boolean): string {
  const owner = restore ? 'www-data:www-data' : `${user}:www-data`;
  const mode = restore ? 'g-w' : 'g+w';
  return `set -euo pipefail
root=${shellQuote(dir.replace(/\/$/, ''))}
test -d "$root" && test ! -L "$root"
test "$(realpath "$root")" = "$root"
shopt -s nullglob dotglob
entries=()
for entry in "$root"/*; do
  name=\${entry##*/}
  if [[ "$name" =~ ^[0-9]+$ ]] && [ -d "$entry" ] && [ ! -L "$entry" ]; then continue; fi
  test ! -L "$entry"
  links=$(find "$entry" -type l -print -quit)
  test -z "$links"
  entries+=("$entry")
done
sudo chown ${shellQuote(owner)} "$root"
sudo chmod ${mode} "$root"
for entry in "\${entries[@]}"; do
  sudo chown -R ${shellQuote(owner)} "$entry"
  sudo chmod -R ${mode} "$entry"
done`;
}

async function withSharedPermissions(deps: TransferDeps, conn: HostConnection, dir: string, fn: () => Promise<void>): Promise<void> {
  let failure: unknown;
  try {
    await execOrThrow(deps.exec, conn, `bash -c ${shellQuote(sharedPermissionsScript(dir, conn.user, false))}`, 'shared permissions (open)');
    await fn();
  } catch (error) { failure = error; }
  try {
    await execOrThrow(deps.exec, conn, `bash -c ${shellQuote(sharedPermissionsScript(dir, conn.user, true))}`, 'shared permissions (restore)');
  } catch (error) {
    if (failure === undefined) throw error;
    deps.log(`[${conn.host}] WARNING: shared permission restore also failed`);
  }
  if (failure !== undefined) throw failure;
}

export async function deployStatic(
  deps: TransferDeps, conn: HostConnection, cfg: WebDeployConfig, buildNumber: string
): Promise<void> {
  const st = cfg.static;
  if (!st) return;
  if (!/^[1-9][0-9]*$/.test(buildNumber)) throw new Error('Invalid numeric build number');
  if (!/^\/(?:[A-Za-z0-9_.-]+\/)+$/.test(st.remotePath) || st.remotePath.split('/').some(p => p === '.' || p === '..')) throw new Error('Unsafe static remote path');
  if (!/^[A-Za-z0-9_-]+$/.test(conn.user)) throw new Error('Unsafe SSH user');
  const dest = `${conn.user}@${conn.host}:${st.remotePath}`;
  const transport = sshTransportString(conn);

  // Phase A: new versioned dir — everything is new, no checksum needed.
  // Scoped to just the new build dir; recursive is fine since it's one small
  // new directory, not the whole webroot.
  // The dir must exist BEFORE the permission wrap: withRemotePermissions's
  // first step is `sudo chown -R` on it, which fails with "No such file or
  // directory" on a fresh build (the dir is only created by the rsync INSIDE
  // the wrap). mkdir -p is idempotent, so this is a no-op on repeat deploys.
  await execOrThrow(deps.exec, conn, `test "$(realpath ${st.remotePath})" = ${shellQuote(st.remotePath.replace(/\/$/, ''))} && test ! -L ${st.remotePath}${buildNumber} && sudo mkdir -p ${st.remotePath}${buildNumber}/ && links=$(find ${st.remotePath}${buildNumber}/ -type l -print -quit) && test -z "$links"`, 'mkdir build dir');
  await withRemotePermissions(deps, conn, `${st.remotePath}${buildNumber}/`, { recursive: true }, async () => {
    deps.log(`[${conn.host}] Phase A: versioned assets ${buildNumber}/ ...`);
    await deps.rsync(buildRsyncArgs({
      src: `${st.localPath}${buildNumber}/`,
      dest: `${dest}${buildNumber}/`,
      transport,
    }));
  });

  // Phase B preserves nested shared write/mtime rights while retained builds
  // stay untouched. Re-enumerate on restoration to include new shared entries.
  await withSharedPermissions(deps, conn, st.remotePath, async () => {
    deps.log(`[${conn.host}] Phase B: shared static files (atomic switchover)...`);
    await deps.rsync(buildRsyncArgs({
      src: `${st.localPath}`,
      dest: `${dest}`,
      transport,
      checksum: true,
      delete: true,
      delayUpdates: true,
      // A positive include for every non-numeric name plus an exclusion for
      // all numeric names protects short and long historical build directories.
      filters: ['+ /*[!0-9]*/', '- /[0-9]*/'],
    }));
  });
}

/**
 * Remove old versioned build dirs, keeping the newest `retentionCount`.
 * MUST run only after CDN purge + version verify (cached HTML may still
 * reference an old /NNNNN/ dir).
 */
export async function cleanupOldBuilds(deps: TransferDeps, conn: HostConnection, cfg: WebDeployConfig): Promise<void> {
  const st = cfg.static;
  if (!st) return;
  const keep = st.retentionCount ?? DEFAULT_RETENTION_COUNT;
  if (!Number.isInteger(keep) || keep < 1) throw new Error('retentionCount must be a positive integer');
  // Non-recursive: the rm -rf inside targets specific build dirs explicitly;
  // the wrap only needs the webroot's own top-level permissions opened, not
  // a recursive walk over every retained build dir.
  await withRemotePermissions(deps, conn, st.remotePath, { recursive: false }, async () => {
    deps.log(`[${conn.host}] Cleaning old version dirs (keeping last ${keep})...`);
    await execOrThrow(
      deps.exec, conn,
      `bash -c ${shellQuote(`set -euo pipefail
root=${shellQuote(st.remotePath.replace(/\/$/, ''))}
test "$(realpath "$root")" = "$root"
shopt -s nullglob
for entry in "$root"/*; do
  name=\${entry##*/}
  if [[ "$name" =~ ^[0-9]+$ ]] && [ -d "$entry" ] && [ ! -L "$entry" ]; then printf '%s\\n' "$name"; fi
done | sort -rn | tail -n +${keep + 1} | while IFS= read -r name; do sudo rm -rf -- "$root/$name"; done`)}`,
      'cleanup old builds'
    );
  });
}

/** Validate source before authentication/transfer. Reject links and special
 * files, including ancestor symlinks; retained numeric trees are not sent. */
export function validateStaticSource(localPath: string, build: string): void {
  if (!/^[1-9][0-9]*$/.test(build)) throw new Error('Invalid numeric build number');
  const root = resolve(localPath);
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Static source must be a real directory without symlink ancestors');
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('Static source contains a symlink');
    if (stat.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); }
    else if (!stat.isFile()) throw new Error('Static source contains a special file');
  };
  if (!lstatSync(join(root, build)).isDirectory()) throw new Error('Missing selected static build directory');
  for (const name of readdirSync(root)) {
    const stat = lstatSync(join(root, name));
    if (name !== build && /^[0-9]+$/.test(name) && stat.isDirectory()) continue;
    visit(join(root, name));
  }
}
