import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import type { HostConnection, RunSummary } from '../types.js';
import { validatePublicationReceipt, type ValidatedPublication } from '../publication.js';
import { verifyRemoteInventory } from '../remote-inventory.js';
import { writeDeploymentResult, beginDeploymentAttempt, validateAttemptId } from '../deployment-result.js';
import { ensureCertificate } from '../ssh-cert.js';
import { DEFAULT_CERT_TTL_SECONDS, DEFAULT_SSH_PRINCIPAL } from '../constants.js';
import { sshExec, sshPipe, withSshSession } from '../ssh-exec.js';
import { verifyDeploy } from '../verify.js';

export function registerVerifyCommand(webdeploy: Command, ctx: CLIPluginContext): void {
  webdeploy
    .command('verify <config>')
    .description('Read-only all-host health, managed nginx and exact-version verification')
    .requiredOption('--receipt <path>', 'Publication receipt for the installed candidate')
    .requiredOption('--config-file <path>', 'Read reviewed config without updating the named store')
    .requiredOption('--expected-build <number>', 'Exact positive integer build expected on every host')
    .option('--attempt-id <uuid>', 'Caller identity for this unique invocation')
    .option('--json', 'Print a machine-readable verification summary')
    .action(
      async (
        name: string,
        options: {
          configFile: string;
          receipt: string;
          expectedBuild: string;
          json?: boolean;
          attemptId?: string;
        }
      ) => {
        const startedAt = new Date().toISOString();
        let publication: ValidatedPublication | undefined;
        let finalSummary: RunSummary | undefined;
        let resultAttempted = false;
        let attemptId: string | undefined;
        try {
          if (options.attemptId) validateAttemptId(options.attemptId);
          if (!/^[1-9][0-9]*$/.test(options.expectedBuild))
            throw new Error('expected-build must be a positive integer');
          publication = validatePublicationReceipt({
            rootDir: process.cwd(),
            receiptPath: options.receipt,
            configFile: options.configFile,
            operation: 'verify',
            expectedBuild: options.expectedBuild,
          });
          attemptId = beginDeploymentAttempt(publication, options.attemptId);
          const cfg = publication.cfg;
          // Only SSH authentication may be acquired. Deployment aliases remain unresolved.
          const certificate = await ensureCertificate(ctx.client, {
            principal: cfg.ssh.principal ?? DEFAULT_SSH_PRINCIPAL,
            ttlSeconds: cfg.ssh.ttlSeconds ?? DEFAULT_CERT_TTL_SECONDS,
          });
          const conns: HostConnection[] = cfg.hosts.map((host) => ({
            host,
            user: cfg.ssh.user,
            port: cfg.ssh.port ?? 22,
            ...certificate,
          }));
          const summary = await withSshSession(conns, (connections) =>
            verifyDeploy(name, cfg, connections, options.expectedBuild, {
              exec: sshExec,
              publication,
              verifyInventory: (conn) => verifyRemoteInventory(sshPipe, conn, publication!),
            })
          );
          finalSummary = summary;
          resultAttempted = true;
          summary.deploymentReceipt = writeDeploymentResult(
            publication,
            'verify',
            startedAt,
            summary,
            attemptId
          );
          if (options.json) console.log(JSON.stringify(summary, null, 2));
          else
            ctx.output.info(
              summary.success
                ? `All hosts verified at build ${summary.build}`
                : JSON.stringify(summary, null, 2)
            );
          process.exitCode = summary.success ? 0 : 1;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          const failed: RunSummary = finalSummary ?? {
            config: name,
            build: options.expectedBuild,
            success: false,
            hosts: [],
            warnings: [],
            timings: [],
          };
          failed.success = false;
          if (publication && attemptId && !resultAttempted) {
            try {
              failed.deploymentReceipt = writeDeploymentResult(
                publication,
                'verify',
                startedAt,
                failed,
                attemptId
              );
            } catch {
              ctx.output.error('Unable to persist failed verification result');
            }
          }
          if (options.json) console.log(JSON.stringify({ ...failed, error }));
          ctx.output.error(error);
          process.exitCode = 1;
        }
      }
    );
}
