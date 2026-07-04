import { describe, it, expect } from 'vitest';
import { parseCertInfo, certIsUsable, ensureCertificate } from '../src/cli/ssh-cert.js';

const KEYGEN_OUTPUT = `/Users/x/.ssh/id_ed25519-webdeploy-cert.pub:
        Type: ssh-ed25519-cert-v01@openssh.com user certificate
        Public key: ED25519-CERT SHA256:abc
        Signing CA: ED25519 SHA256:def (using ssh-ed25519)
        Key ID: "diego"
        Serial: 42
        Valid: from 2026-07-04T10:00:00 to 2026-07-04T18:00:00
        Principals:
                deploy
                developer
        Critical Options: (none)
        Extensions:
                permit-pty
`;

describe('parseCertInfo', () => {
  it('extracts principals and validBefore', () => {
    const info = parseCertInfo(KEYGEN_OUTPUT);
    expect(info.principals).toEqual(['deploy', 'developer']);
    expect(info.validBefore?.getFullYear()).toBe(2026);
  });
});

describe('certIsUsable', () => {
  const info = parseCertInfo(KEYGEN_OUTPUT);
  it('accepts a fresh cert with the right principal', () => {
    expect(certIsUsable(info, 'deploy', new Date('2026-07-04T12:00:00')).ok).toBe(true);
  });
  it('rejects when the principal is missing', () => {
    const res = certIsUsable(info, 'admin', new Date('2026-07-04T12:00:00'));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/principal/);
  });
  it('rejects when expiring within 5 minutes', () => {
    expect(certIsUsable(info, 'deploy', new Date('2026-07-04T17:57:00')).ok).toBe(false);
  });
});

describe('ensureCertificate', () => {
  it('signs via /v1/ssh/sign when no usable cert exists', async () => {
    const files: Record<string, string> = { '/k/id_ed25519.pub': 'ssh-ed25519 AAAA test' };
    let signedBody: unknown;
    const client = {
      get: async <T>() => ({} as T),
      post: async <T>(path: string, body: unknown): Promise<T> => {
        expect(path).toBe('/v1/ssh/sign');
        signedBody = body;
        return { certificate: 'ssh-ed25519-cert-v01 CERTDATA' } as T;
      },
    };
    const io = {
      exists: (p: string) => p in files,
      read: (p: string) => files[p] ?? '',
      write: (p: string, c: string) => { files[p] = c; },
      sshKeygenL: () => { throw new Error('no cert yet'); },
    };
    const res = await ensureCertificate(client, { principal: 'deploy', ttlSeconds: 3600, keyPath: '/k/id_ed25519', io });
    expect(res.certPath).toBe('/k/id_ed25519-webdeploy-cert.pub');
    expect(files[res.certPath]).toContain('CERTDATA');
    expect(signedBody).toEqual({ publicKey: 'ssh-ed25519 AAAA test', ttlSeconds: 3600, principals: ['deploy'] });
  });
});
