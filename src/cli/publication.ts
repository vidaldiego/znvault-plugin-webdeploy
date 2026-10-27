import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { validateDeployConfig } from './config-validate.js';
import type { WebDeployConfig } from './types.js';

export interface FileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}
export interface PublicationReceipt {
  schemaVersion: 1;
  kind: 'zincapp-webdeploy-publication';
  sourceCommit: string;
  build: string;
  artifact: {
    schemaVersion: 1;
    kind: 'zincapp-webdeploy-artifact';
    build: string;
    artifactSha256: string;
    fileCount: number;
    totalBytes: number;
    files: FileIdentity[];
  };
  configuration: FileIdentity[];
  validation: {
    validatedAt: string;
    mode: 'full' | 'hotfix';
    policyHash: string;
    tests: string[];
    inputHash: string;
    toolchainHash: string;
  };
}
export interface PublicationOptions {
  rootDir: string;
  receiptPath: string;
  configFile: string;
  operation: 'run' | 'verify';
  expectedBuild?: string;
  now?: number;
}
export interface ValidatedPublication {
  rootDir: string;
  receiptPath: string;
  configFile: string;
  receipt: PublicationReceipt;
  cfg: WebDeployConfig;
  publicationReceiptSha256: string;
  recheck(): void;
}
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
function keys(value: unknown, expected: string[]): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
export function safeRelative(value: string): void {
  if (
    typeof value !== 'string' ||
    !value ||
    isAbsolute(value) ||
    value.includes('\\') ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Unsafe publication path');
}
export function safeLocalPath(root: string, path: string): string {
  safeRelative(path);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Publication paths must not contain symlinks');
  }
  return current;
}
function identities(files: FileIdentity[]): void {
  if (!Array.isArray(files) || !files.length) throw new Error('Missing file identities');
  const seen = new Set<string>();
  for (const file of files) {
    if (!keys(file, ['path', 'bytes', 'sha256'])) throw new Error('Malformed file identity');
    safeRelative(file.path);
    if (seen.has(file.path)) throw new Error('Duplicate publication path');
    seen.add(file.path);
    if (
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== 'string' ||
      !HASH.test(file.sha256)
    )
      throw new Error('Invalid file digest or size');
  }
}
export interface Exclusion {
  path: string;
  rootOnly: boolean;
}
export function appExclusions(cfg: WebDeployConfig): Exclusion[] {
  const rules: Exclusion[] = [];
  for (const input of cfg.app?.exclude ?? []) {
    if (typeof input !== 'string' || [...input].some((c) => '*?[]!'.includes(c)))
      throw new Error('Publication exclusions must be exact runtime paths');
    const path = input.replace(/^\//, '').replace(/\/$/, '');
    safeRelative(path);
    rules.push({ path, rootOnly: input.startsWith('/') || path.includes('/') });
  }
  for (const path of ['.env', '.deploy-install-stamp', ...Object.keys(cfg.app?.files ?? {})]) {
    safeRelative(path);
    rules.push({ path, rootOnly: true });
  }
  return rules;
}
export function isExcluded(path: string, rules: Exclusion[]): boolean {
  return rules.some((rule) =>
    rule.rootOnly
      ? path === rule.path || path.startsWith(rule.path + '/')
      : path.split('/').includes(rule.path)
  );
}
function fingerprint(root: string, path: string, logicalPath = path): FileIdentity {
  const full = safeLocalPath(root, path);
  if (!lstatSync(full).isFile()) throw new Error('Publication inventory requires regular files');
  const bytes = readFileSync(full);
  return { path: logicalPath, bytes: bytes.length, sha256: sha256(bytes) };
}
function inventory(root: string, cfg: WebDeployConfig, build: string): FileIdentity[] {
  const files: FileIdentity[] = [];
  const walk = (disk: string, logical: string): void => {
    const full = safeLocalPath(root, disk),
      stat = lstatSync(full);
    if (stat.isDirectory())
      for (const name of readdirSync(full)) walk(`${disk}/${name}`, `${logical}/${name}`);
    else files.push(fingerprint(root, disk, logical));
  };
  if (cfg.app) walk(cfg.app.localPath.replace(/\/$/, ''), 'app');
  if (cfg.static) {
    const source = cfg.static.localPath.replace(/\/$/, '');
    const full = safeLocalPath(root, source);
    if (!lstatSync(safeLocalPath(root, `${source}/${build}`)).isDirectory())
      throw new Error('Missing selected build inventory');
    for (const name of readdirSync(full)) {
      const entry = safeLocalPath(root, `${source}/${name}`);
      if (/^[0-9]+$/.test(name) && name !== build && lstatSync(entry).isDirectory()) continue;
      walk(`${source}/${name}`, `static/${name}`);
    }
  }
  files.push(fingerprint(root, cfg.versionFile, 'release/shared-version'));
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}
export function validatePublicationReceipt(options: PublicationOptions): ValidatedPublication {
  const root = resolve(options.rootDir);
  if (realpathSync(root) !== root) throw new Error('Repository root must not contain symlinks');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  if (
    realpathSync(git('rev-parse', '--show-toplevel')) !== root ||
    git('status', '--porcelain', '--untracked-files=all')
  )
    throw new Error('Publication requires a clean repository checkout');
  const receiptRelative = relative(root, resolve(root, options.receiptPath));
  const receiptPath = safeLocalPath(root, receiptRelative);
  if (!lstatSync(receiptPath).isFile()) throw new Error('Receipt must be a regular file');
  const bytes = readFileSync(receiptPath);
  const receipt = JSON.parse(bytes.toString('utf8')) as PublicationReceipt;
  if (
    !keys(receipt, [
      'schemaVersion',
      'kind',
      'sourceCommit',
      'build',
      'artifact',
      'configuration',
      'validation',
    ]) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== 'zincapp-webdeploy-publication' ||
    !/^[a-f0-9]{40}$/.test(receipt.sourceCommit) ||
    typeof receipt.build !== 'string' ||
    !/^[0-9]{5,}$/.test(receipt.build)
  )
    throw new Error('Malformed publication receipt');
  if (receipt.sourceCommit !== git('rev-parse', 'HEAD'))
    throw new Error('Publication source does not match HEAD');
  const v = receipt.validation;
  if (
    !keys(v, ['validatedAt', 'mode', 'policyHash', 'tests', 'inputHash', 'toolchainHash']) ||
    !['full', 'hotfix'].includes(v.mode) ||
    ![v.policyHash, v.inputHash, v.toolchainHash].every((h) => typeof h === 'string' && HASH.test(h)) ||
    !Array.isArray(v.tests) ||
    v.tests.some((t) => typeof t !== 'string') ||
    new Set(v.tests).size !== v.tests.length ||
    (v.mode === 'hotfix' && !v.tests.length)
  )
    throw new Error('Malformed validation evidence');
  v.tests.forEach(safeRelative);
  const validatedAt = Date.parse(v.validatedAt),
    now = options.now ?? Date.now();
  if (
    typeof v.validatedAt !== 'string' ||
    !Number.isFinite(validatedAt) ||
    new Date(validatedAt).toISOString() !== v.validatedAt
  )
    throw new Error('Invalid validation date');
  if (validatedAt > now) throw new Error('Validation date is in the future');
  if (options.operation === 'run' && now - validatedAt >= 24 * 3600000)
    throw new Error('Publication validation expired');
  const a = receipt.artifact;
  if (
    !keys(a, ['schemaVersion', 'kind', 'build', 'files', 'artifactSha256', 'fileCount', 'totalBytes']) ||
    a.schemaVersion !== 1 ||
    a.kind !== 'zincapp-webdeploy-artifact' ||
    a.build !== receipt.build
  )
    throw new Error('Malformed artifact identity');
  identities(a.files);
  identities(receipt.configuration);
  const subject = { schemaVersion: 1, kind: 'zincapp-webdeploy-artifact', build: a.build, files: a.files };
  if (
    a.artifactSha256 !== sha256(JSON.stringify(subject) + '\n') ||
    a.fileCount !== a.files.length ||
    a.totalBytes !== a.files.reduce((sum, f) => sum + f.bytes, 0) ||
    !Number.isSafeInteger(a.totalBytes)
  )
    throw new Error('Artifact digest identity mismatch');
  const configRelative = relative(root, resolve(root, options.configFile));
  const configFile = safeLocalPath(root, configRelative);
  const cfg = JSON.parse(readFileSync(configFile, 'utf8')) as WebDeployConfig;
  const errors = validateDeployConfig(cfg);
  if (errors.length) throw new Error('Invalid reviewed deployment configuration');
  if (
    !cfg.app ||
    !cfg.static ||
    !cfg.verify ||
    !cfg.nginx?.config ||
    !cfg.healthChecks?.length ||
    new Set(cfg.hosts).size !== cfg.hosts.length
  )
    throw new Error('Publication requires app, static, version, nginx and all-host health gates');
  for (const path of [cfg.app.remotePath, cfg.static.remotePath]) {
    if (!/^\/?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(path)) throw new Error('Unsafe remote path');
    safeRelative(path.replace(/^\//, '').replace(/\/$/, ''));
  }
  if (!cfg.static.remotePath.startsWith('/')) throw new Error('Static remote path must be absolute');
  const expectedConfig = [configRelative, cfg.nginx.config.localPath];
  if (
    receipt.configuration.length !== expectedConfig.length ||
    expectedConfig.some((path) => !receipt.configuration.some((f) => f.path === path))
  )
    throw new Error('Configuration paths mismatch');
  for (const file of receipt.configuration)
    if (JSON.stringify(file) !== JSON.stringify(fingerprint(root, file.path)))
      throw new Error('Configuration byte identity mismatch');
  if (options.expectedBuild !== undefined && options.expectedBuild !== receipt.build)
    throw new Error('Expected build differs from publication');
  if (readFileSync(safeLocalPath(root, cfg.versionFile), 'utf8').trim() !== receipt.build)
    throw new Error('Local version differs from publication');
  const excluded = appExclusions(cfg);
  for (const f of a.files) {
    if (f.path.startsWith('app/')) {
      if (isExcluded(f.path.slice(4), excluded)) throw new Error('Manifest path is excluded from transfer');
    } else if (f.path.startsWith('static/')) {
      const first = f.path.split('/')[1]!;
      if (/^[0-9]+$/.test(first) && first !== receipt.build)
        throw new Error('Manifest includes excluded retained build');
    } else if (f.path !== 'release/shared-version') throw new Error('Unknown logical inventory path');
  }
  if (JSON.stringify(inventory(root, cfg, receipt.build)) !== JSON.stringify(a.files))
    throw new Error('Local artifact inventory mismatch');
  const publicationReceiptSha256 = sha256(bytes);
  return {
    rootDir: root,
    receiptPath,
    configFile,
    receipt,
    cfg,
    publicationReceiptSha256,
    recheck() {
      const next = validatePublicationReceipt({ ...options, now: undefined });
      if (next.publicationReceiptSha256 !== publicationReceiptSha256)
        throw new Error('Publication receipt changed');
    },
  };
}
