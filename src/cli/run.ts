// Path: src/cli/run.ts
import type { Exec, ExecPipe, HostConnection, HostDeployResult, RunSummary, WebDeployConfig } from './types.js';
import { syncAppDir, installAppDeps, deployStatic, cleanupOldBuilds, type TransferDeps } from './transfer.js';
import { writeRemoteFileIfChanged } from './remote-files.js';
import { reloadOrStartPm2, reloadNginx } from './pm2.js';
import { runHealthChecks } from './health.js';
import { purgeCloudflare, verifyVersions } from './cdn-cloudflare.js';
import { sendWebhook, syncHelp } from './notify.js';
import { VERSION_VERIFY_CEILING_MS } from './constants.js';
import { probeVersion } from './http-probe.js';
import { readFileSync } from 'node:fs';
import { applyNginx, assertNginxBaseline, checkNginxListeners, digest, readNginxHash, rollbackNginx, type NginxChange } from './nginx.js';

export interface RunDeps {
  exec: Exec;
  pipe: ExecPipe;
  rsync(args: string[]): Promise<void>;
  fetchImpl: typeof fetch;
  log(line: string): void;
  readVersionFile(path: string): string;
  // retained for API stability: no call site in run.ts invokes this today
  // (the last sleep-based wait, CDN purge propagation, was removed in a
  // prior quick-win); kept on the interface + wired in commands/run.ts so
  // external callers/tests that already depend on this shape don't break.
  sleep(ms: number): Promise<void>;
  /** Masks registered secret values in a string; applied to webhook bodies before POST. */
  redact(line: string): string;
  /** Passed through to reloadOrStartPm2's settleMs. Omit to keep the production default. */
  pm2SettleMs?: number;
  /** Injectable Host-header-aware HTTP probe for verifyVersions. Omit to use the real node:http probe. */
  probeVersion?: typeof probeVersion;
  /** Injectable verification retry ceiling for deterministic tests. */
  versionVerifyCeilingMs?: number;
  readNginxFile?: (path: string) => string;
}

export function renderEnvFile(env: Record<string, string>): string {
  for (const [k, v] of Object.entries(env)) {
    if (v.includes('\n')) {
      throw new Error(`.env value for key '${k}' contains a newline, which would corrupt the rendered .env file`);
    }
  }
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

async function deployHost(cfg: WebDeployConfig, conn: HostConnection, build: string, deps: RunDeps, nginxContent?: string): Promise<NginxChange | undefined> {
  const tdeps: TransferDeps = { exec: deps.exec, rsync: deps.rsync, log: deps.log };

  if (cfg.app) {
    await syncAppDir(tdeps, conn, cfg);
    // Rendered files must exist BEFORE yarn install: .yarnrc.yml carries the
    // registry tokens the install needs (rsync just shipped a token-less tree).
    if (cfg.app.env) {
      await writeRemoteFileIfChanged(deps.exec, deps.pipe, conn, `${cfg.app.remotePath}/.env`, renderEnvFile(cfg.app.env));
    }
    for (const [file, content] of Object.entries(cfg.app.files ?? {})) {
      await writeRemoteFileIfChanged(deps.exec, deps.pipe, conn, `${cfg.app.remotePath}/${file}`, content);
    }
    await installAppDeps(tdeps, conn, cfg);
  }

  await deployStatic(tdeps, conn, cfg, build);

  if (cfg.app) {
    await reloadOrStartPm2(deps.exec, conn, { remotePath: cfg.app.remotePath, app: cfg.app.pm2App, log: deps.log, settleMs: deps.pm2SettleMs });
  }
  if (cfg.nginx?.config && nginxContent !== undefined) {
    await checkNginxListeners(deps.exec, conn, nginxContent, cfg.nginx.config);
    const change = await applyNginx(deps.exec, deps.pipe, conn, cfg.nginx.config, nginxContent);
    try {
      // applyNginx already validated/reloaded a changed config. The unchanged
      // case still reloads after the application/static rollout.
      if (!change) await reloadNginx(deps.exec, conn);
      if (await readNginxHash(deps.exec, conn, cfg.nginx.config) !== digest(nginxContent)) throw new Error('nginx post-deploy drift');
      await checkNginxListeners(deps.exec, conn, nginxContent, cfg.nginx.config);
      return change;
    } catch (error) {
      if (change) await rollbackNginx(deps.exec, conn, cfg.nginx.config, change);
      throw error;
    }
  }
  // Default: reload only when `static` is deployed (nginx serves it directly).
  // An explicit `nginx.reload: true` overrides that and reloads regardless —
  // e.g. an nginx config templated/managed outside of `static` still needs
  // a reload after this run touches it.
  if (cfg.nginx?.reload === true || (cfg.nginx?.reload !== false && !!cfg.static)) {
    await reloadNginx(deps.exec, conn);
  }
  return undefined;
}

export async function runDeploy(
  configName: string,
  cfg: WebDeployConfig,
  conns: HostConnection[],
  deps: RunDeps
): Promise<RunSummary> {
  const build = deps.readVersionFile(cfg.versionFile).trim();
  const warnings: string[] = [];
  const hosts: HostDeployResult[] = [];
  let abort = false;
  let mutationAttempted = false;
  // Freeze the reviewed bytes once, and reject fleet drift BEFORE rsync,
  // dependency installation, PM2 or any config write on the first host.
  const managed = cfg.nginx?.config;
  const nginxContent = managed ? (deps.readNginxFile ?? (p => readFileSync(p, 'utf8')))(managed.localPath) : undefined;
  if (managed && nginxContent !== undefined) {
    for (const conn of conns) {
      assertNginxBaseline(await readNginxHash(deps.exec, conn, managed), nginxContent, managed);
    }
  }

  for (let i = 0; i < conns.length; i++) {
    const conn = conns[i]!;
    if (abort) {
      deps.log(`[${conn.host}] Skipped (previous host failed the gate).`);
      hosts.push({ host: conn.host, success: false, skipped: true, healthResults: [], healthOk: false });
      continue;
    }

    let nginxChange: NginxChange | undefined;
    try {
      deps.log(`=== Deploying ${conn.host} (${i + 1}/${conns.length}) ===`);
      mutationAttempted = true;
      nginxChange = await deployHost(cfg, conn, build, deps, nginxContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[${conn.host}] ❌ Deploy failed: ${message}`);
      hosts.push({ host: conn.host, success: false, error: message, healthResults: [], healthOk: false });
      abort = true;
      continue;
    }

    // Health gate (also run on the last host, for the summary)
    const health = await runHealthChecks(deps.exec, conn, cfg.healthChecks ?? []).catch(() => ({ success: false, results: ['❌ Health probe failed'] }));
    hosts.push({ host: conn.host, success: true, healthResults: health.results, healthOk: health.success });
    if (!health.success) {
      if (nginxChange && managed) {
        try {
          await rollbackNginx(deps.exec, conn, managed, nginxChange);
          warnings.push(`nginx restored on ${conn.host}; application rollback remains a separate recovery step`);
        } catch (error) { warnings.push((error as Error).message); }
      }
      warnings.push(`health check failed on ${conn.host}`);
      if (i < conns.length - 1) {
        deps.log(`[${conn.host}] ❌ Health gate failed — aborting remaining hosts.`);
        abort = true;
      }
    }
  }

  const summary: RunSummary = {
    config: configName,
    build,
    hosts,
    warnings,
    success: false,
  };

  const anyDeployed = hosts.some(h => h.success);
  if (anyDeployed) {
    if (cfg.cdn) {
      summary.purge = await purgeCloudflare(deps.fetchImpl, cfg.cdn);
      if (!summary.purge.ok) warnings.push(`CDN purge failed: ${summary.purge.detail ?? ''}`);
    }
    if (cfg.verify) {
      summary.verify = await verifyVersions(
        deps.probeVersion ?? probeVersion,
        hosts.filter(h => h.success).map(h => h.host),
        {
          expected: build,
          versionPath: cfg.verify.versionPath,
          hostHeader: cfg.verify.hostHeader,
          retryCeilingMs: deps.versionVerifyCeilingMs ?? VERSION_VERIFY_CEILING_MS,
        }
      );
      if (summary.verify && !summary.verify.allMatch) warnings.push('version verification mismatch on at least one host');
    }
  }

  const hostGatesOk = hosts.length === conns.length && hosts.every(h => h.success && h.healthOk);
  const purgeOk = !cfg.cdn || summary.purge?.ok === true;
  const versionOk = !cfg.verify || summary.verify?.allMatch === true;
  summary.success = hostGatesOk && purgeOk && versionOk;
  summary.recoveryRequired = mutationAttempted && !summary.success;

  // Old assets are the recovery boundary for stale cached HTML and an
  // incomplete rollout. Retire them only after every blocking gate converges.
  if (anyDeployed && summary.success) {
    const tdeps: TransferDeps = { exec: deps.exec, rsync: deps.rsync, log: deps.log };
    for (const h of hosts) {
      const conn = conns.find(c => c.host === h.host)!;
      try {
        await cleanupOldBuilds(tdeps, conn, cfg);
      } catch (err) {
        warnings.push(`cleanup failed on ${h.host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else if (summary.recoveryRequired) {
    warnings.push('deployment changed at least one host but did not pass every gate; old builds were retained for recovery');
  }

  if (cfg.notify?.helpSync) await syncHelp(deps.fetchImpl, cfg.notify.helpSync, deps.log);
  if (cfg.notify?.webhook) await sendWebhook(deps.fetchImpl, cfg.notify.webhook, summary, deps.redact);

  return summary;
}
