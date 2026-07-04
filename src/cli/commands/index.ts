// Path: src/cli/commands/index.ts
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { registerConfigCommands } from './config.js';
import { registerRunCommand } from './run.js';
import { registerCheckCommand } from './check.js';
import { registerStatusCommand } from './status.js';

export function registerAllCommands(webdeploy: Command, ctx: CLIPluginContext): void {
  registerRunCommand(webdeploy, ctx);
  registerCheckCommand(webdeploy, ctx);
  registerStatusCommand(webdeploy, ctx);
  registerConfigCommands(webdeploy, ctx);
}
