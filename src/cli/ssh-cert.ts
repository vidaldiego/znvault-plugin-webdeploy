// Path: src/cli/ssh-cert.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CLIPluginContext } from './plugin-types.js';

type VaultClient = CLIPluginContext['client'];

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_KEY_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa'];

export interface CertIO {
  exists(p: string): boolean;
  read(p: string): string;
  write(p: string, content: string): void;
  sshKeygenL(certPath: string): string;
}

const realIO: CertIO = {
  exists: existsSync,
  read: p => readFileSync(p, 'utf-8'),
  write: (p, c) => writeFileSync(p, c, { mode: 0o600 }),
  sshKeygenL: p => execSync(`ssh-keygen -L -f "${p}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }),
};

export interface CertInfo { principals: string[]; validBefore: Date | null }

export function parseCertInfo(output: string): CertInfo {
  const validMatch = output.match(/Valid:\s+from\s+\S+\s+to\s+(\S+)/);
  const validBefore = validMatch?.[1] ? new Date(validMatch[1]) : null;

  const principals: string[] = [];
  const lines = output.split('\n');
  const start = lines.findIndex(l => l.trim().startsWith('Principals:'));
  if (start !== -1) {
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (/^\s+\S/.test(line) && !line.includes(':')) principals.push(line.trim());
      else break;
    }
  }
  return { principals, validBefore };
}

export function certIsUsable(info: CertInfo, principal: string, now: Date): { ok: boolean; reason?: string } {
  if (!info.validBefore) return { ok: false, reason: 'could not parse validity' };
  if (info.validBefore.getTime() - now.getTime() < EXPIRY_BUFFER_MS) return { ok: false, reason: 'expired or expiring soon' };
  if (!info.principals.includes(principal)) return { ok: false, reason: `missing principal '${principal}' (has: ${info.principals.join(', ') || 'none'})` };
  return { ok: true };
}

function findDefaultKey(io: CertIO): string {
  const sshDir = join(homedir(), '.ssh');
  for (const name of DEFAULT_KEY_NAMES) {
    if (io.exists(join(sshDir, name)) && io.exists(join(sshDir, `${name}.pub`))) return join(sshDir, name);
  }
  throw new Error(`No SSH key found in ${sshDir} (looked for ${DEFAULT_KEY_NAMES.join(', ')})`);
}

export async function ensureCertificate(
  client: VaultClient,
  opts: { principal: string; ttlSeconds: number; keyPath?: string; io?: CertIO }
): Promise<{ keyPath: string; certPath: string }> {
  const io = opts.io ?? realIO;
  const keyPath = opts.keyPath ?? findDefaultKey(io);
  const certPath = `${keyPath}-webdeploy-cert.pub`;

  if (io.exists(certPath)) {
    try {
      const info = parseCertInfo(io.sshKeygenL(certPath));
      if (certIsUsable(info, opts.principal, new Date()).ok) return { keyPath, certPath };
    } catch {
      // fall through to re-sign
    }
  }

  const publicKey = io.read(`${keyPath}.pub`).trim();
  const result = await client.post<{ certificate: string }>('/v1/ssh/sign', {
    publicKey,
    ttlSeconds: opts.ttlSeconds,
    principals: [opts.principal],
  });
  io.write(certPath, result.certificate.trim() + '\n');
  return { keyPath, certPath };
}
