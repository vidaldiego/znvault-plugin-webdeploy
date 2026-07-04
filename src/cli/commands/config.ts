// Path: src/cli/commands/config.ts
import type { Command } from 'commander';
import type { CLIPluginContext } from '../plugin-types.js';
import { loadConfigs, getConfig, importConfigFile } from '../config-store.js';
import { validateDeployConfig } from '../config-validate.js';

export function registerConfigCommands(webdeploy: Command, ctx: CLIPluginContext): void {
  const config = webdeploy.command('config').description('Manage deployment configurations');

  config.command('list').description('List config names').action(async () => {
    const store = await loadConfigs();
    const names = Object.keys(store.configs);
    if (names.length === 0) ctx.output.info('No configs. Add one: znvault webdeploy config import <name> <file.json>');
    for (const n of names) ctx.output.info(n);
  });

  config.command('show <name>').description('Show a config (JSON)').action(async (name: string) => {
    console.log(JSON.stringify(await getConfig(name), null, 2));
  });

  config.command('validate <name>').description('Validate a stored config').action(async (name: string) => {
    const errors = validateDeployConfig(await getConfig(name));
    if (errors.length === 0) { ctx.output.success(`Config '${name}' is valid.`); return; }
    for (const e of errors) ctx.output.error(e);
    process.exitCode = 1;
  });

  config.command('import <name> <file>').description('Import a config from a JSON file').action(async (name: string, file: string) => {
    await importConfigFile(name, file);
    ctx.output.success(`Config '${name}' imported.`);
  });
}
