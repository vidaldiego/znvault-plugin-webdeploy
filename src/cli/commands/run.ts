// Path: src/cli/commands/run.ts
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import type { HostConnection, RunSummary, WebDeployConfig, PhaseTiming } from '../types.js';
import { getConfig } from '../config-store.js';
import { validateDeployConfig } from '../config-validate.js';
import { validatePublicationReceipt, type ValidatedPublication } from '../publication.js';
import { writeDeploymentResult, beginDeploymentAttempt, validateAttemptId } from '../deployment-result.js';
import { Redactor, resolveConfigSecrets } from '../secret-resolver.js';
import { ensureCertificate } from '../ssh-cert.js';
import { sshExec, sshPipe, runRsync, validateRsyncVersion, withSshSession } from '../ssh-exec.js';
import { acquireLock, releaseLock, installLockHandlers } from '../lock.js';
import { runDeploy, type RunDeps } from '../run.js';
import { validateStaticSource } from '../transfer.js';
import {
  DEFAULT_CERT_TTL_SECONDS,
  DEFAULT_SSH_PRINCIPAL,
  DEPLOY_SESSION_BUDGET_MS,
  HOST_AUTHORIZATION_MARGIN_MS,
} from '../constants.js';

export function buildSummaryLines(summary: RunSummary): string[] {
  const lines: string[] = [];
  lines.push('='.repeat(60));
  lines.push(`Deploy summary — config '${summary.config}'`);
  lines.push(`Build: ${summary.build}`);
  for (const h of summary.hosts) {
    if (h.success && h.healthOk) lines.push(`  ✅ ${h.host}`);
    else if (h.success) lines.push(`  ❌ ${h.host}: health gate failed`);
    else if (h.skipped) lines.push(`  ⏭️ ${h.host}: skipped`);
    else lines.push(`  ❌ ${h.host}: ${h.error ?? 'failed'}`);
    for (const r of h.healthResults) lines.push(`      ${r}`);
  }
  if (summary.purge)
    lines.push(
      summary.purge.ok ? '  ✅ CDN purge ok' : `  ❌ CDN purge failed: ${summary.purge.detail ?? ''}`
    );
  if (summary.verify)
    lines.push(
      summary.verify.allMatch
        ? '  ✅ All hosts serve the expected version'
        : '  ❌ Version mismatch on at least one host'
    );
  if (summary.recoveryRequired) lines.push('  ❌ Recovery required; old builds were retained.');
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
  redactor: Redactor,
  configFile?: string,
  reviewedConfig?: WebDeployConfig
): Promise<{ cfg: WebDeployConfig; conns: HostConnection[]; redactor: Redactor }> {
  const stored =
    reviewedConfig ??
    (configFile ? (JSON.parse(readFileSync(configFile, 'utf8')) as WebDeployConfig) : await getConfig(name));
  const errors = validateDeployConfig(stored);
  if (errors.length > 0) throw new Error(`Invalid config '${name}': ${errors.join('; ')}`);

  if (stored.static && !reviewedConfig)
    validateStaticSource(stored.static.localPath, readFileSync(stored.versionFile, 'utf8').trim());
  const cfg = await resolveConfigSecrets(ctx.client, stored, redactor);

  const { keyPath, certPath, certificateExpiresAt } = await ensureCertificate(ctx.client, {
    minimumValidityMs: DEPLOY_SESSION_BUDGET_MS + HOST_AUTHORIZATION_MARGIN_MS,
    principal: stored.ssh.principal ?? DEFAULT_SSH_PRINCIPAL,
    ttlSeconds: stored.ssh.ttlSeconds ?? DEFAULT_CERT_TTL_SECONDS,
  });
  assertTransportSafePaths(keyPath, certPath);
  const conns: HostConnection[] = cfg.hosts.map((host) => ({
    host,
    port: cfg.ssh.port ?? 22,
    user: cfg.ssh.user,
    keyPath,
    certPath,
    certificateExpiresAt,
  }));
  return { cfg, conns, redactor };
}

export function registerRunCommand(webdeploy: Command, ctx: CLIPluginContext): void {
  webdeploy
    .command('run <config>')
    .description('Run a gated rolling deploy')
    .option('--attempt-id <uuid>', 'Caller identity for this unique invocation')
    .option('--json', 'Print a machine-readable summary to stdout')
    .requiredOption('--receipt <path>', 'Verified publication receipt for this candidate')
    .requiredOption(
      '--config-file <path>',
      'Use the reviewed repository config, without changing the named config store (paths relative to cwd)'
    )
    .option('--dry-run', 'Resolve, validate and print the plan without touching hosts')
    .option('--skip-purge', 'Skip the CDN purge step')
    .action(
      async (
        name: string,
        options: {
          json?: boolean;
          attemptId?: string;
          dryRun?: boolean;
          skipPurge?: boolean;
          configFile: string;
          receipt: string;
        }
      ) => {
        const redactor = new Redactor();
        const startedAt = new Date().toISOString();
        let publication: ValidatedPublication | undefined;
        let finalSummary: RunSummary | undefined;
        let resultAttempted = false;
        let attemptId: string | undefined;
        try {
          if (options.attemptId) validateAttemptId(options.attemptId);
          publication = validatePublicationReceipt({
            rootDir: process.cwd(),
            receiptPath: options.receipt,
            configFile: options.configFile,
            operation: 'run',
          });
          if (options.dryRun) {
            console.log(
              JSON.stringify({
                config: name,
                build: publication.receipt.build,
                artifactSha256: publication.receipt.artifact.artifactSha256,
                dryRun: true,
              })
            );
            return;
          }
          attemptId = beginDeploymentAttempt(publication, options.attemptId);
          if (options.skipPurge) throw new Error('--skip-purge is forbidden for publication');
          validateRsyncVersion();
          const { cfg, conns } = await prepareResolvedRun(
            ctx,
            name,
            redactor,
            options.configFile,
            publication.cfg
          );

          acquireLock(name);
          installLockHandlers(name);
          try {
            const deps: RunDeps = {
              publication,
              exec: sshExec,
              pipe: sshPipe,
              rsync: (args) => runRsync(args, (line) => ctx.output.info(redactor.redact(line.trimEnd()))),
              fetchImpl: fetch,
              log: (line) => ctx.output.info(redactor.redact(line)),
              readVersionFile: (p) => readFileSync(p, 'utf-8'),
              sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
              redact: (s) => redactor.redact(s),
            };
            const summary = await withSshSession(
              conns,
              (connections) => runDeploy(name, cfg, connections, deps),
              { maxDurationMs: DEPLOY_SESSION_BUDGET_MS }
            );

            finalSummary = summary;
            resultAttempted = true;
            summary.deploymentReceipt = writeDeploymentResult(
              publication,
              'run',
              startedAt,
              summary,
              attemptId
            );
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
          const failed: RunSummary = finalSummary ?? {
            config: name,
            build: publication?.receipt.build ?? '',
            hosts: [],
            warnings: [],
            success: false,
            timings: (err as { timings?: PhaseTiming[] })?.timings ?? [],
          };
          failed.success = false;
          if (publication && attemptId && !resultAttempted) {
            try {
              failed.deploymentReceipt = writeDeploymentResult(
                publication,
                'run',
                startedAt,
                failed,
                attemptId
              );
            } catch {
              ctx.output.error('Unable to persist failed deployment result');
            }
          }
          if (options.json)
            console.log(
              redactor.redact(
                JSON.stringify({ ...failed, error: err instanceof Error ? err.message : String(err) })
              )
            );
          ctx.output.error(redactor.redact(err instanceof Error ? err.message : String(err)));
          process.exitCode = 1;
        }
      }
    );
}
