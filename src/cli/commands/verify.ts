import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import type { HostConnection, WebDeployConfig } from '../types.js';
import { getConfig } from '../config-store.js';
import { validateDeployConfig } from '../config-validate.js';
import { ensureCertificate } from '../ssh-cert.js';
import { DEFAULT_CERT_TTL_SECONDS, DEFAULT_SSH_PRINCIPAL } from '../constants.js';
import { sshExec, withSshSession } from '../ssh-exec.js';
import { verifyDeploy } from '../verify.js';

export function registerVerifyCommand(webdeploy: Command, ctx: CLIPluginContext): void {
  webdeploy.command('verify <config>')
    .description('Read-only all-host health, managed nginx and exact-version verification')
    .option('--config-file <path>', 'Read reviewed config without updating the named store')
    .requiredOption('--expected-build <number>', 'Exact positive integer build expected on every host')
    .option('--json', 'Print a machine-readable verification summary')
    .action(async (name: string, options: { configFile?: string; expectedBuild: string; json?: boolean }) => {
      try {
        if (!/^[1-9][0-9]*$/.test(options.expectedBuild)) throw new Error('expected-build must be a positive integer');
        const cfg = options.configFile ? JSON.parse(readFileSync(options.configFile, 'utf8')) as WebDeployConfig : await getConfig(name);
        const errors = validateDeployConfig(cfg);
        if (errors.length) throw new Error(`Invalid config: ${errors.join('; ')}`);
        if (!cfg.verify || !cfg.nginx?.config || !cfg.healthChecks?.length) throw new Error('verify requires version, managed nginx and healthChecks configuration');
        // Only SSH authentication may be acquired. Deployment aliases remain unresolved.
        const certificate = await ensureCertificate(ctx.client, { principal: cfg.ssh.principal ?? DEFAULT_SSH_PRINCIPAL, ttlSeconds: cfg.ssh.ttlSeconds ?? DEFAULT_CERT_TTL_SECONDS });
        const conns: HostConnection[] = cfg.hosts.map(host => ({host, user: cfg.ssh.user, port: cfg.ssh.port ?? 22, ...certificate}));
        const summary = await withSshSession(conns, connections => verifyDeploy(name, cfg, connections, options.expectedBuild, {exec: sshExec}));
        if (options.json) console.log(JSON.stringify(summary, null, 2));
        else ctx.output.info(summary.success ? `All hosts verified at build ${summary.build}` : JSON.stringify(summary, null, 2));
        process.exitCode = summary.success ? 0 : 1;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (options.json) console.log(JSON.stringify({config:name,build:options.expectedBuild,success:false,hosts:[],timings:[],error}));
        ctx.output.error(error); process.exitCode = 1;
      }
    });
}
