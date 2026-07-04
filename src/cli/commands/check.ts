// Path: src/cli/commands/check.ts
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { prepareResolvedRun } from './run.js';
import { Redactor } from '../secret-resolver.js';
import { sshExec, validateRsyncVersion } from '../ssh-exec.js';
import { runHealthChecks } from '../health.js';

export function registerCheckCommand(webdeploy: Command, ctx: CLIPluginContext): void {
  webdeploy
    .command('check <config>')
    .description('Preflight: vault auth, secrets, cert, host reachability, health')
    .action(async (name: string) => {
      const redactor = new Redactor();
      let failed = false;

      try {
        try { validateRsyncVersion(); ctx.output.success('✅ rsync >= 3.1.0'); }
        catch (err) { ctx.output.error(`❌ ${err instanceof Error ? err.message : String(err)}`); failed = true; }

        // Resolving secrets + signing the cert proves vault auth works.
        const { cfg, conns } = await prepareResolvedRun(ctx, name, redactor);
        ctx.output.success('✅ Config valid, secrets resolved, SSH certificate ready');

        for (const conn of conns) {
          const ping = await sshExec(conn, 'echo ok');
          if (ping.code === 0 && ping.stdout.trim() === 'ok') {
            ctx.output.success(`✅ SSH ${conn.user}@${conn.host}: ok`);
          } else {
            ctx.output.error(`❌ SSH ${conn.user}@${conn.host}: ${redactor.redact(ping.stderr.trim())}`);
            failed = true;
            continue;
          }
          const health = await runHealthChecks(sshExec, conn, cfg.healthChecks ?? []);
          for (const r of health.results) ctx.output.info(redactor.redact(`   ${r}`));
          if (!health.success) failed = true;
        }

        process.exitCode = failed ? 1 : 0;
      } catch (err) {
        ctx.output.error(redactor.redact(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    });
}
