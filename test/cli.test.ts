import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import createWebdeployCLIPlugin from '../src/cli.js';
import type { CLIPluginContext } from '../src/cli/plugin-types.js';

function fakeCtx(): CLIPluginContext {
  return {
    client: { get: async () => ({} as never), post: async () => ({} as never) },
    output: { success() {}, error() {}, warn() {}, info() {} },
    getConfig: () => ({ url: 'https://vault.test' }),
    isPlainMode: () => true,
  };
}

describe('createWebdeployCLIPlugin', () => {
  it('exposes name, semver version and registerCommands', () => {
    const plugin = createWebdeployCLIPlugin();
    expect(plugin.name).toBe('webdeploy');
    expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof plugin.registerCommands).toBe('function');
  });

  it('registers a top-level webdeploy command group', () => {
    const plugin = createWebdeployCLIPlugin();
    const program = new Command();
    plugin.registerCommands(program, fakeCtx());
    const names = program.commands.map(c => c.name());
    expect(names).toContain('webdeploy');
  });
});
