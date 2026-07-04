// Path: src/cli/plugin-types.ts
// Mirror of znvault-cli's CLIPlugin/CLIPluginContext contract (structural typing).

import type { Command } from 'commander';

export interface CLIPluginContext {
  client: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
  };
  output: {
    success(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    info(message: string): void;
  };
  getConfig(): { url: string };
  isPlainMode(): boolean;
}

export interface CLIPlugin {
  name: string;
  version: string;
  description?: string;
  registerCommands(program: Command, ctx: CLIPluginContext): void;
}
