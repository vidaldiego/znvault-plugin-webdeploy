import { describe, it, expect } from 'vitest';
import { parseSecretRef, Redactor, resolveRef, resolveConfigSecrets } from '../src/cli/secret-resolver.js';

// Fake vault client: alias -> {id}; id -> decrypt payload
function fakeClient(secrets: Record<string, Record<string, unknown>>) {
  return {
    async get<T>(path: string): Promise<T> {
      const alias = decodeURIComponent(path.replace('/v1/secrets/alias/', ''));
      if (!secrets[alias]) throw new Error(`404 alias ${alias}`);
      return { id: `id-${alias}` } as T;
    },
    async post<T>(path: string, _body: unknown): Promise<T> {
      const alias = path.replace('/v1/secrets/', '').replace('/decrypt', '').replace('id-', '');
      return { id: `id-${alias}`, alias, data: secrets[alias] } as T;
    },
  };
}

describe('parseSecretRef', () => {
  it('splits alias and field on the last dot', () => {
    expect(parseSecretRef('alias:webapp/prod/cloudflare.token'))
      .toEqual({ kind: 'alias', alias: 'webapp/prod/cloudflare', field: 'token' });
  });
  it('treats non-alias strings as plain', () => {
    expect(parseSecretRef('production')).toEqual({ kind: 'plain', value: 'production' });
  });
  it('strips the literal: prefix instead of treating it as part of the value', () => {
    expect(parseSecretRef('literal:production')).toEqual({ kind: 'plain', value: 'production' });
  });
});

describe('resolveRef', () => {
  it('resolves alias.field via alias lookup + decrypt', async () => {
    const client = fakeClient({ 'webapp/prod/cloudflare': { token: 'cf-tok-1', zoneId: 'z1' } });
    const r = new Redactor();
    expect(await resolveRef(client, 'alias:webapp/prod/cloudflare.token', r)).toBe('cf-tok-1');
    expect(r.redact('header cf-tok-1 trailer')).toBe('header [REDACTED] trailer');
  });

  it('uses data.value when no field given', async () => {
    const client = fakeClient({ 'webapp/prod/webhook': { value: 'https://hooks/x' } });
    expect(await resolveRef(client, 'alias:webapp/prod/webhook', new Redactor())).toBe('https://hooks/x');
  });

  it('base64-decodes file secrets (data.content)', async () => {
    const client = fakeClient({ 'webapp/prod/yarnrc': { content: Buffer.from('npmAuthToken: x').toString('base64') } });
    expect(await resolveRef(client, 'alias:webapp/prod/yarnrc', new Redactor())).toBe('npmAuthToken: x');
  });

  it('throws a helpful error when the field is missing', async () => {
    const client = fakeClient({ 'a/b': { other: '1' } });
    await expect(resolveRef(client, 'alias:a/b.nope', new Redactor())).rejects.toThrow(/nope.*a\/b/);
  });

  it('renders a literal: ref as its value with the prefix stripped, without a vault round-trip', async () => {
    const client = fakeClient({}); // would throw if touched
    expect(await resolveRef(client, 'literal:production', new Redactor())).toBe('production');
  });
});

describe('Redactor ordering', () => {
  it('redacts longer secrets before their substrings (no partial leaks)', () => {
    const r = new Redactor();
    r.add('ab');            // registered first
    r.add('xaby');          // contains 'ab' as substring
    expect(r.redact('token=xaby other=ab')).toBe('token=[REDACTED] other=[REDACTED]');
  });
});

describe('Redactor transformed representations', () => {
  it('masks a multi-line secret even when only its second line appears in the text', () => {
    const r = new Redactor();
    const pemLike = '-----BEGIN KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBK\n-----END KEY-----';
    r.add(pemLike);
    expect(r.redact('leaked: MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBK')).toBe('leaked: [REDACTED]');
  });

  it('masks the JSON-escaped form of a secret containing a double quote inside a JSON.stringify document', () => {
    const r = new Redactor();
    const secret = 'p@ss"word';
    r.add(secret);
    const doc = JSON.stringify({ token: secret });
    expect(doc).not.toContain(secret); // sanity: JSON.stringify really did escape it
    const redacted = r.redact(doc);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('ss\\"word');
    expect(redacted).toContain('[REDACTED]');
  });
});

describe('resolveConfigSecrets', () => {
  it('replaces refs everywhere and leaves plain values untouched', async () => {
    const client = fakeClient({
      'webapp/prod/api': { key: 'T18_new' },
      'webapp/prod/cloudflare': { token: 'cf2', zoneId: 'zone2' },
    });
    const cfg = {
      hosts: ['h1'], ssh: { user: 'u' }, versionFile: 'v',
      app: { localPath: 'deploy', remotePath: 'app', pm2App: 'www',
             env: { API_KEY: 'alias:webapp/prod/api.key', NODE_ENV: 'production' } },
      cdn: { provider: 'cloudflare' as const, zoneId: 'alias:webapp/prod/cloudflare.zoneId',
             apiToken: 'alias:webapp/prod/cloudflare.token', purge: 'everything' as const },
    };
    const r = new Redactor();
    const resolved = await resolveConfigSecrets(client, cfg as never, r);
    expect(resolved.app?.env).toEqual({ API_KEY: 'T18_new', NODE_ENV: 'production' });
    expect(resolved.cdn?.apiToken).toBe('cf2');
    expect(r.redact('x T18_new y cf2')).toBe('x [REDACTED] y [REDACTED]');
    // original untouched
    expect(cfg.app.env.API_KEY).toBe('alias:webapp/prod/api.key');
  });
});
