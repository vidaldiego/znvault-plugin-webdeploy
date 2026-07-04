// Path: src/cli.ts
// znvault CLI plugin entrypoint. The loader imports the DEFAULT export and
// calls it as a factory, so this file must `export default` the factory.

import { createRequire } from 'node:module';
import type { Command } from 'commander';
import type { CLIPlugin, CLIPluginContext } from './cli/plugin-types.js';
import { registerAllCommands } from './cli/commands/index.js';

const require = createRequire(import.meta.url);

function readVersion(): string {
  try {
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createWebdeployCLIPlugin(): CLIPlugin {
  return {
    name: 'webdeploy',
    version: readVersion(),
    description: 'Generic web-app deployment (rsync/PM2/nginx over SSH-CA)',
    registerCommands(program: Command, ctx: CLIPluginContext): void {
      const webdeploy = program
        .command('webdeploy')
        .description('Web-app deployment & management (static + Node over SSH-CA)');
      registerAllCommands(webdeploy, ctx);
    },
  };
}

export default createWebdeployCLIPlugin;
