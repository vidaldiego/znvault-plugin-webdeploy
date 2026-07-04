// Path: src/cli/commands/run.ts
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import type { HostConnection, RunSummary, WebDeployConfig } from '../types.js';
import { getConfig } from '../config-store.js';
import { validateDeployConfig } from '../config-validate.js';
import { Redactor, resolveConfigSecrets } from '../secret-resolver.js';
import { ensureCertificate } from '../ssh-cert.js';
import { sshExec, sshPipe, runRsync, validateRsyncVersion } from '../ssh-exec.js';
import { acquireLock, releaseLock, installLockHandlers } from '../lock.js';
import { runDeploy, type RunDeps } from '../run.js';
import { DEFAULT_CERT_TTL_SECONDS, DEFAULT_SSH_PRINCIPAL } from '../constants.js';

export function buildSummaryLines(summary: RunSummary): string[] {
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push(`Deploy summary — config '${summary.config}'`);
  lines.push(`Build: ${summary.build}`);
  for (const h of summary.hosts) {
    if (h.success) lines.push(`  ✅ ${h.host}${h.healthOk ? '' : ' (health warnings)'}`);
    else if (h.skipped) lines.push(`  ⏭️ ${h.host}: skipped`);
    else lines.push(`  ❌ ${h.host}: ${h.error ?? 'failed'}`);
    for (const r of h.healthResults) lines.push(`      ${r}`);
  }
  if (summary.purge) lines.push(summary.purge.ok ? '  ✅ CDN purge ok' : `  ⚠️ CDN purge failed: ${summary.purge.detail ?? ''}`);
  if (summary.verify) lines.push(summary.verify.allMatch ? '  ✅ All hosts serve the expected version' : '  ⚠️ Version mismatch on at least one host');
  for (const w of summary.warnings) lines.push(`  ⚠️ ${w}`);
  lines.push(summary.success ? '🎉 Deploy complete.' : '❌ Deploy incomplete — see above.');
  lines.push('='.repeat(60));
  return lines;
}

/**
 * rsync's `-e` transport string is whitespace-split by rsync itself with no
 * quoting support (see ssh-exec.ts `sshTransportString`/`buildRsyncArgs`), so
 * a key/cert path containing a space would silently corrupt the ssh command
 * line. Fail loudly instead of shipping a broken transport string.
 */
export function assertTransportSafePaths(keyPath: string, certPath: string): void {
  if (/\s/.test(keyPath)) {
    throw new Error(
      `SSH key path contains whitespace, which rsync's -e transport cannot carry (no quoting support): '${keyPath}'`
    );
  }
  if (/\s/.test(certPath)) {
    throw new Error(
      `SSH certificate path contains whitespace, which rsync's -e transport cannot carry (no quoting support): '${certPath}'`
    );
  }
}

export async function prepareResolvedRun(
  ctx: CLIPluginContext,
  name: string,
  redactor: Redactor
): Promise<{ cfg: WebDeployConfig; conns: HostConnection[]; redactor: Redactor }> {
  const stored = await getConfig(name);
  const errors = validateDeployConfig(stored);
  if (errors.length > 0) throw new Error(`Invalid config '${name}': ${errors.join('; ')}`);

  const cfg = await resolveConfigSecrets(ctx.client, stored, redactor);

  const { keyPath, certPath } = await ensureCertificate(ctx.client, {
    principal: stored.ssh.principal ?? DEFAULT_SSH_PRINCIPAL,
    ttlSeconds: stored.ssh.ttlSeconds ?? DEFAULT_CERT_TTL_SECONDS,
  });
  assertTransportSafePaths(keyPath, certPath);
  const conns: HostConnection[] = cfg.hosts.map(host => ({
    host, port: cfg.ssh.port ?? 22, user: cfg.ssh.user, keyPath, certPath,
  }));
  return { cfg, conns, redactor };
}

export function registerRunCommand(webdeploy: Command, ctx: CLIPluginContext): void {
  webdeploy
    .command('run <config>')
    .description('Run a gated rolling deploy')
    .option('--json', 'Print a machine-readable summary to stdout')
    .option('--dry-run', 'Resolve, validate and print the plan without touching hosts')
    .option('--skip-purge', 'Skip the CDN purge step')
    .action(async (name: string, options: { json?: boolean; dryRun?: boolean; skipPurge?: boolean }) => {
      const redactor = new Redactor();
      try {
        validateRsyncVersion();
        const { cfg, conns } = await prepareResolvedRun(ctx, name, redactor);
        if (options.skipPurge) delete cfg.cdn;

        if (options.dryRun) {
          const planned = {
            config: name,
            hosts: cfg.hosts,
            app: cfg.app ? { remotePath: cfg.app.remotePath, pm2App: cfg.app.pm2App, envKeys: Object.keys(cfg.app.env ?? {}) } : undefined,
            static: cfg.static,
            cdn: cfg.cdn ? { zoneId: '[set]', purge: cfg.cdn.purge } : undefined,
          };
          console.log(redactor.redact(JSON.stringify(planned, null, 2)));
          return;
        }

        acquireLock(name);
        installLockHandlers(name);
        try {
          const deps: RunDeps = {
            exec: sshExec,
            pipe: sshPipe,
            rsync: args => runRsync(args, line => ctx.output.info(redactor.redact(line.trimEnd()))),
            fetchImpl: fetch,
            log: line => ctx.output.info(redactor.redact(line)),
            readVersionFile: p => readFileSync(p, 'utf-8'),
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            redact: s => redactor.redact(s),
          };
          const summary = await runDeploy(name, cfg, conns, deps);

          if (options.json) {
            console.log(redactor.redact(JSON.stringify(summary, null, 2)));
          } else {
            for (const line of buildSummaryLines(summary)) ctx.output.info(redactor.redact(line));
          }
          process.exitCode = summary.success ? 0 : 1;
        } finally {
          releaseLock(name);
        }
      } catch (err) {
        ctx.output.error(redactor.redact(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });
}
