// Path: src/cli/types.ts

export type HealthCheckSpec =
  | { type: 'systemd'; unit: string }
  | { type: 'http'; url: string; expectStatus?: number }
  | { type: 'pm2'; app: string }
  | { type: 'ports'; ports: number[] }
  | { type: 'file'; path: string }
  | { type: 'disk'; warnAt?: number; failAt?: number }
  | { type: 'memory'; warnAt?: number; failAt?: number };

export interface WebDeployConfig {
  hosts: string[];
  ssh: { user: string; port?: number; principal?: string; ttlSeconds?: number };
  /** Local file whose trimmed content is the build number (e.g. shared/version). */
  versionFile: string;
  app?: {
    /** Local staged dir to rsync (e.g. "deploy"). Staging it is the caller's job. */
    localPath: string;
    /** Remote app dir relative to the SSH user's home (e.g. "zincapp-ts"). */
    remotePath: string;
    pm2App: string;
    exclude?: string[];
    /** Rendered to <remotePath>/.env — values are alias: refs or plain non-secrets. */
    env?: Record<string, string>;
    /** Extra rendered files: remote-relative path -> alias: ref (whole file content). */
    files?: Record<string, string>;
    /** corepack pin, e.g. "4.9.1". Omit to skip corepack/yarn install. */
    yarnVersion?: string;
  };
  static?: {
    localPath: string;      // e.g. "public/"
    remotePath: string;     // e.g. "/var/www/"
    retentionCount?: number; // default 50
  };
  nginx?: { reload?: boolean }; // default true when `static` present
  healthChecks?: HealthCheckSpec[];
  cdn?: {
    provider: 'cloudflare';
    zoneId: string;   // alias: ref or plain
    apiToken: string; // alias: ref ONLY
    purge: 'everything' | string[];
  };
  verify?: { versionPath: string; hostHeader?: string };
  notify?: {
    webhook?: string; // alias: ref ONLY
    helpSync?: { url: string; key: string; contentDir: string }; // key: alias: ref ONLY
  };
}

export interface HostConnection {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  certPath: string;
}

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (conn: HostConnection, command: string) => Promise<ExecResult>;
export type ExecPipe = (conn: HostConnection, command: string, stdin: string) => Promise<ExecResult>;

export interface HostDeployResult {
  host: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
  healthResults: string[];
  healthOk: boolean;
}

export interface RunSummary {
  config: string;
  build: string;
  hosts: HostDeployResult[];
  purge?: { ok: boolean; detail?: string };
  verify?: { allMatch: boolean; results: { server: string; match: boolean; actual: string }[] };
  warnings: string[];
  /** true iff every host deployed (drives exit code) */
  success: boolean;
}
