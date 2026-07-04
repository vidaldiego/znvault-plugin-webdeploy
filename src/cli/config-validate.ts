// Path: src/cli/config-validate.ts
import type { WebDeployConfig } from './types.js';

/**
 * Env keys whose values must be alias: references. Any key matching these
 * patterns is treated as a secret; plain values are rejected for them.
 */
const SECRET_ENV_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;
/** Non-secret allowlist for env values regardless of key name. */
const PLAIN_ENV_VALUES = new Set(['production', 'development', 'staging', 'test', 'true', 'false']);

export const SECRET_FIELDS =
  'cdn.apiToken, app.env.<SECRET-like keys>, app.files.*, notify.webhook, notify.helpSync.key';

function isAliasRef(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith('alias:') && v.length > 'alias:'.length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateDeployConfig(raw: unknown): string[] {
  const errors: string[] = [];
  const cfg = raw as Partial<WebDeployConfig> | null | undefined;

  if (!cfg || typeof cfg !== 'object') return ['config must be an object'];

  if (!Array.isArray(cfg.hosts) || cfg.hosts.length === 0 || !cfg.hosts.every(h => typeof h === 'string' && h.length > 0)) {
    errors.push('hosts must be a non-empty string array');
  }
  if (cfg.ssh !== undefined && !isPlainObject(cfg.ssh)) {
    errors.push('ssh must be an object');
  } else if (!cfg.ssh || typeof cfg.ssh.user !== 'string' || cfg.ssh.user.length === 0) {
    errors.push('ssh.user is required');
  }
  if (typeof cfg.versionFile !== 'string' || cfg.versionFile.length === 0) {
    errors.push('versionFile is required');
  }
  if (!cfg.app && !cfg.static) {
    errors.push('at least one of app/static must be configured');
  }

  if (cfg.app !== undefined && !isPlainObject(cfg.app)) {
    errors.push('app must be an object');
  } else if (cfg.app) {
    for (const k of ['localPath', 'remotePath', 'pm2App'] as const) {
      if (typeof cfg.app[k] !== 'string' || cfg.app[k].length === 0) errors.push(`app.${k} is required`);
    }
    if (cfg.app.env !== undefined && !isPlainObject(cfg.app.env)) {
      errors.push('app.env must be an object');
    } else {
      for (const [key, value] of Object.entries(cfg.app.env ?? {})) {
        if (SECRET_ENV_KEY.test(key) && !isAliasRef(value) && !PLAIN_ENV_VALUES.has(String(value))) {
          errors.push(`app.env.${key} looks secret; value must be an alias: reference`);
        }
      }
    }
    if (cfg.app.files !== undefined && !isPlainObject(cfg.app.files)) {
      errors.push('app.files must be an object');
    } else {
      for (const [file, value] of Object.entries(cfg.app.files ?? {})) {
        if (!isAliasRef(value)) errors.push(`app.files["${file}"] must be an alias: reference`);
      }
    }
  }

  if (cfg.static !== undefined && !isPlainObject(cfg.static)) {
    errors.push('static must be an object');
  } else if (cfg.static) {
    for (const k of ['localPath', 'remotePath'] as const) {
      const value = cfg.static[k];
      if (typeof value !== 'string' || value.length === 0) {
        errors.push(`static.${k} is required`);
      } else if (!value.endsWith('/')) {
        errors.push(`static.${k} must end with '/'`);
      }
    }
  }

  if (cfg.cdn !== undefined && !isPlainObject(cfg.cdn)) {
    errors.push('cdn must be an object');
  } else if (cfg.cdn) {
    if (cfg.cdn.provider !== 'cloudflare') errors.push('cdn.provider must be "cloudflare"');
    if (!isAliasRef(cfg.cdn.apiToken)) errors.push('cdn.apiToken must be an alias: reference (never a literal)');
    if (typeof cfg.cdn.zoneId !== 'string' || cfg.cdn.zoneId.length === 0) errors.push('cdn.zoneId is required');
    if (cfg.cdn.purge !== 'everything' && !Array.isArray(cfg.cdn.purge)) errors.push('cdn.purge must be "everything" or a URL array');
  }

  if (cfg.notify !== undefined && !isPlainObject(cfg.notify)) {
    errors.push('notify must be an object');
  } else {
    if (cfg.notify?.webhook !== undefined && !isAliasRef(cfg.notify.webhook)) {
      errors.push('notify.webhook must be an alias: reference');
    }
    if (cfg.notify?.helpSync !== undefined && !isPlainObject(cfg.notify.helpSync)) {
      errors.push('notify.helpSync must be an object');
    } else if (cfg.notify?.helpSync && !isAliasRef(cfg.notify.helpSync.key)) {
      errors.push('notify.helpSync.key must be an alias: reference');
    }
  }

  return errors;
}
