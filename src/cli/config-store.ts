// Path: src/cli/config-store.ts
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebDeployConfig } from './types.js';
import { validateDeployConfig } from './config-validate.js';
import { WEBDEPLOY_CONFIG_DIR, CONFIG_FILE_NAME } from './constants.js';

export interface ConfigStore { configs: Record<string, WebDeployConfig> }

function fileFor(dir: string): string { return join(dir, CONFIG_FILE_NAME); }

export async function loadConfigs(dir: string = WEBDEPLOY_CONFIG_DIR): Promise<ConfigStore> {
  const file = fileFor(dir);
  if (!existsSync(file)) return { configs: {} };
  try {
    return JSON.parse(await readFile(file, 'utf-8')) as ConfigStore;
  } catch {
    return { configs: {} };
  }
}

export async function saveConfigs(store: ConfigStore, dir: string = WEBDEPLOY_CONFIG_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = fileFor(dir);
  await writeFile(file, JSON.stringify(store, null, 2), { mode: 0o600 });
  await chmod(file, 0o600); // writeFile mode is ignored if the file pre-exists
}

export async function getConfig(name: string, dir?: string): Promise<WebDeployConfig> {
  const store = await loadConfigs(dir);
  const cfg = store.configs[name];
  if (!cfg) throw new Error(`Config '${name}' not found. Run: znvault webdeploy config list`);
  return cfg;
}

export async function setConfig(name: string, cfg: WebDeployConfig, dir?: string): Promise<void> {
  const errors = validateDeployConfig(cfg);
  if (errors.length > 0) throw new Error(`Invalid config: ${errors.join('; ')}`);
  const store = await loadConfigs(dir);
  store.configs[name] = cfg;
  await saveConfigs(store, dir);
}

export async function importConfigFile(name: string, filePath: string, dir?: string): Promise<void> {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as WebDeployConfig;
  await setConfig(name, raw, dir);
}
