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
}

export function renderEnvFile(env: Record<string, string>): string {
  for (const [k, v] of Object.entries(env)) {
    if (v.includes('\n')) {
      throw new Error(`.env value for key '${k}' contains a newline, which would corrupt the rendered .env file`);
    }
  }
  return Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

async function deployHost(cfg: WebDeployConfig, conn: HostConnection, build: string, deps: RunDeps): Promise<void> {
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
  // Default: reload only when `static` is deployed (nginx serves it directly).
  // An explicit `nginx.reload: true` overrides that and reloads regardless —
  // e.g. an nginx config templated/managed outside of `static` still needs
  // a reload after this run touches it.
  if (cfg.nginx?.reload === true || (cfg.nginx?.reload !== false && !!cfg.static)) {
    await reloadNginx(deps.exec, conn);
  }
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

  for (let i = 0; i < conns.length; i++) {
    const conn = conns[i]!;
    if (abort) {
      deps.log(`[${conn.host}] Skipped (previous host failed the gate).`);
      hosts.push({ host: conn.host, success: false, skipped: true, healthResults: [], healthOk: false });
      continue;
    }

    try {
      deps.log(`=== Deploying ${conn.host} (${i + 1}/${conns.length}) ===`);
      await deployHost(cfg, conn, build, deps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[${conn.host}] ❌ Deploy failed: ${message}`);
      hosts.push({ host: conn.host, success: false, error: message, healthResults: [], healthOk: false });
      abort = true;
      continue;
    }

    // Health gate (also run on the last host, for the summary)
    const health = await runHealthChecks(deps.exec, conn, cfg.healthChecks ?? []);
    hosts.push({ host: conn.host, success: true, healthResults: health.results, healthOk: health.success });
    if (!health.success) {
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
    success: hosts.every(h => h.success),
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
          retryCeilingMs: VERSION_VERIFY_CEILING_MS,
        }
      );
      if (summary.verify && !summary.verify.allMatch) warnings.push('version verification mismatch on at least one host');
    }
    const tdeps: TransferDeps = { exec: deps.exec, rsync: deps.rsync, log: deps.log };
    for (const h of hosts) {
      if (!h.success) continue;
      const conn = conns.find(c => c.host === h.host)!;
      try {
        await cleanupOldBuilds(tdeps, conn, cfg);
      } catch (err) {
        warnings.push(`cleanup failed on ${h.host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (cfg.notify?.helpSync) await syncHelp(deps.fetchImpl, cfg.notify.helpSync, deps.log);
  if (cfg.notify?.webhook) await sendWebhook(deps.fetchImpl, cfg.notify.webhook, summary, deps.redact);

  return summary;
}
