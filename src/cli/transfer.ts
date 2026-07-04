// Path: src/cli/transfer.ts
import type { Exec, HostConnection, WebDeployConfig } from './types.js';
import { buildRsyncArgs, execOrThrow, sshTransportString } from './ssh-exec.js';
import { DEFAULT_RETENTION_COUNT } from './constants.js';

export interface TransferDeps {
  exec: Exec;
  rsync(args: string[]): Promise<void>;
  log(line: string): void;
}

const VERSIONED_DIR_GLOB = '[0-9][0-9][0-9][0-9][0-9]*';

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
  await execOrThrow(deps.exec, conn, `sudo chown ${flag}${conn.user}:www-data ${dir}`, 'chown (open)');
  await execOrThrow(deps.exec, conn, `sudo chmod ${flag}g+w ${dir}`, 'chmod (open)');
  let fnError: unknown;
  try {
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

  let localHash: string;
  const hashRes = await deps.exec(
    conn,
    `sha256sum ${app.remotePath}/package.json ${app.remotePath}/yarn.lock 2>/dev/null | sha256sum | cut -d" " -f1`
  );
  if (hashRes.code !== 0) {
    // Fail safe: if we can't even compute the hash, force an install.
    localHash = `unhashable-${Date.now()}-${Math.random()}`;
  } else {
    // `sha256sum | cut -d" " -f1` already isolates the hash, but split
    // defensively on whitespace too — sha256sum's own line format is
    // "<hash>  -", and this keeps the parse robust regardless of exactly
    // how the remote shell rendered it.
    localHash = hashRes.stdout.trim().split(/\s+/)[0] ?? '';
  }

  const stampRes = await deps.exec(conn, `cat ${stampPath} 2>/dev/null`);
  const remoteStampHash = stampRes.code === 0 ? stampRes.stdout.trim() : null;

  const presentRes = await deps.exec(
    conn,
    `test -d ${app.remotePath}/node_modules && echo present || echo absent`
  );
  const nodeModulesPresent = presentRes.code === 0 && presentRes.stdout.trim() === 'present';

  if (!shouldInstallRemote(localHash, remoteStampHash, nodeModulesPresent)) {
    deps.log(`[${conn.host}] deps unchanged — skipping install (QW4)`);
    return;
  }

  deps.log(`[${conn.host}] Pinning yarn@${app.yarnVersion} and installing...`);
  await execOrThrow(deps.exec, conn, `cd ${app.remotePath} && corepack use yarn@${app.yarnVersion}`, 'corepack use');
  await execOrThrow(deps.exec, conn, `cd ${app.remotePath} && yarn install`, 'yarn install');
  await execOrThrow(deps.exec, conn, `printf %s "${localHash}" > ${stampPath}`, 'write install stamp');
}

export async function deployStatic(
  deps: TransferDeps, conn: HostConnection, cfg: WebDeployConfig, buildNumber: string
): Promise<void> {
  const st = cfg.static;
  if (!st) return;
  const dest = `${conn.user}@${conn.host}:${st.remotePath}`;
  const transport = sshTransportString(conn);

  // Phase A: new versioned dir — everything is new, no checksum needed.
  // Scoped to just the new build dir; recursive is fine since it's one small
  // new directory, not the whole webroot.
  // The dir must exist BEFORE the permission wrap: withRemotePermissions's
  // first step is `sudo chown -R` on it, which fails with "No such file or
  // directory" on a fresh build (the dir is only created by the rsync INSIDE
  // the wrap). mkdir -p is idempotent, so this is a no-op on repeat deploys.
  await execOrThrow(deps.exec, conn, `sudo mkdir -p ${st.remotePath}${buildNumber}/`, 'mkdir build dir');
  await withRemotePermissions(deps, conn, `${st.remotePath}${buildNumber}/`, { recursive: true }, async () => {
    deps.log(`[${conn.host}] Phase A: versioned assets ${buildNumber}/ ...`);
    await deps.rsync(buildRsyncArgs({
      src: `${st.localPath}${buildNumber}/`,
      dest: `${dest}${buildNumber}/`,
      transport,
    }));
  });

  // Phase B: shared files + HTML, atomically staged (--delay-updates) so a
  // request mid-transfer never sees a truncated file. MUST be recursive:
  // rsync -a (checksum mode) preserves mtimes, and it recurses into
  // pre-existing shared subdirectories (e.g. tinymce/plugins/*) that are
  // owned by www-data, not the deploy user. Non-recursive g+w on the
  // webroot only grants write on the top-level dir itself — it does not
  // grant utimensat() rights on nested dirs/files the deploy user doesn't
  // own, so rsync fails with "failed to set times on ... Operation not
  // permitted" (exit 23) the moment it walks into one of those dirs.
  // Recursive chown makes the deploy user the owner all the way down, same
  // as the pre-QW3 behavior, so mtime preservation on unchanged nested
  // shared dirs succeeds again.
  await withRemotePermissions(deps, conn, st.remotePath, { recursive: true }, async () => {
    deps.log(`[${conn.host}] Phase B: shared static files (atomic switchover)...`);
    await deps.rsync(buildRsyncArgs({
      src: `${st.localPath}`,
      dest: `${dest}`,
      transport,
      checksum: true,
      delete: true,
      delayUpdates: true,
      filters: [`- /${VERSIONED_DIR_GLOB}/`],
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
  // Non-recursive: the rm -rf inside targets specific build dirs explicitly;
  // the wrap only needs the webroot's own top-level permissions opened, not
  // a recursive walk over every retained build dir.
  await withRemotePermissions(deps, conn, st.remotePath, { recursive: false }, async () => {
    deps.log(`[${conn.host}] Cleaning old version dirs (keeping last ${keep})...`);
    await execOrThrow(
      deps.exec, conn,
      `cd ${st.remotePath} && ls -d ${VERSIONED_DIR_GLOB}/ 2>/dev/null | sed 's|/||' | sort -rn | tail -n +${keep + 1} | xargs -r -I{} sudo rm -rf ${st.remotePath}{}`,
      'cleanup old builds'
    );
  });
}
