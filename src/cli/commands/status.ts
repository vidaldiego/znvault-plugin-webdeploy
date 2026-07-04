// Path: src/cli/commands/status.ts
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { getConfig } from '../config-store.js';
import { HTTP_TIMEOUT_MS } from '../constants.js';
import { probeVersion } from '../http-probe.js';

export function registerStatusCommand(webdeploy: Command, ctx: CLIPluginContext): void {
  webdeploy
    .command('status <config>')
    .description('Show the served version on each host')
    .action(async (name: string) => {
      const cfg = await getConfig(name);
      if (!cfg.verify) { ctx.output.warn('No verify.versionPath configured.'); return; }
      for (const host of cfg.hosts) {
        const res = await probeVersion(host, cfg.verify.versionPath, {
          hostHeader: cfg.verify.hostHeader,
          timeoutMs: HTTP_TIMEOUT_MS,
        });
        if (res.ok) ctx.output.info(`${host}: ${res.body.trim()}`);
        else ctx.output.warn(`${host}: ${res.status ? `HTTP ${res.status}` : res.body}`);
      }
    });
}
