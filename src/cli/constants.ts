// Path: src/cli/constants.ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export const WEBDEPLOY_CONFIG_DIR = join(homedir(), '.znvault', 'webdeploy');
export const CONFIG_FILE_NAME = 'configs.json';
export const DEFAULT_RETENTION_COUNT = 50;
export const DEFAULT_SSH_PRINCIPAL = 'deploy';
export const DEFAULT_CERT_TTL_SECONDS = 3600;
export const VERSION_VERIFY_CEILING_MS = 5000;
export const HTTP_TIMEOUT_MS = 10_000;

/** Bound mutation invocations; preserve time for remote traps before certificate expiry. */
export const DEPLOY_SESSION_BUDGET_MS = 30 * 60_000;
export const HOST_AUTHORIZATION_MARGIN_MS = 5 * 60_000;
