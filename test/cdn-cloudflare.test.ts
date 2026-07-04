import { describe, it, expect } from 'vitest';
import { purgeCloudflare, verifyVersions } from '../src/cli/cdn-cloudflare.js';
import type { probeVersion } from '../src/cli/http-probe.js';

function fakeFetch(handler: (url: string, init?: RequestInit) => { status: number; body: string }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init);
    return new Response(r.body, { status: r.status });
  }) as typeof fetch;
}

function fakeProbe(
  handler: (host: string, path: string, opts: { hostHeader?: string; timeoutMs: number }) => { status: number; body: string }
): typeof probeVersion {
  return async (host, path, opts) => {
    const r = handler(host, path, opts);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, body: r.body };
  };
}

describe('purgeCloudflare', () => {
  it('POSTs purge_everything with bearer token', async () => {
    let captured: { url?: string; auth?: string; body?: string } = {};
    const f = fakeFetch((url, init) => {
      captured = { url, auth: (init?.headers as Record<string, string>)['Authorization'], body: String(init?.body) };
      return { status: 200, body: '{"success":true}' };
    });
    const res = await purgeCloudflare(f, { zoneId: 'Z1', apiToken: 'TOK', purge: 'everything' });
    expect(res.ok).toBe(true);
    expect(captured.url).toBe('https://api.cloudflare.com/client/v4/zones/Z1/purge_cache');
    expect(captured.auth).toBe('Bearer TOK');
    expect(JSON.parse(captured.body!)).toEqual({ purge_everything: true });
  });

  it('reports failure detail on non-2xx', async () => {
    const res = await purgeCloudflare(fakeFetch(() => ({ status: 403, body: 'nope' })), { zoneId: 'Z', apiToken: 'T', purge: 'everything' });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/403/);
  });
});

describe('verifyVersions', () => {
  it('compares served version with expected per host', async () => {
    const probe = fakeProbe(host => ({ status: 200, body: host === '10.0.0.1' ? '30412' : '30411' }));
    const res = await verifyVersions(probe, ['10.0.0.1', '10.0.0.2'], { expected: '30412', versionPath: '/version', hostHeader: 'my.zincapp.com' });
    expect(res?.allMatch).toBe(false);
    expect(res?.results).toEqual([
      { server: '10.0.0.1', match: true, actual: '30412' },
      { server: '10.0.0.2', match: false, actual: '30411' },
    ]);
  });

  it('passes the configured hostHeader and versionPath through to the probe', async () => {
    const seen: { host: string; path: string; hostHeader?: string }[] = [];
    const probe = fakeProbe((host, path, opts) => {
      seen.push({ host, path, hostHeader: opts.hostHeader });
      return { status: 200, body: '30412' };
    });
    await verifyVersions(probe, ['10.0.0.1'], { expected: '30412', versionPath: '/version', hostHeader: 'my.zincapp.com' });
    expect(seen).toEqual([{ host: '10.0.0.1', path: '/version', hostHeader: 'my.zincapp.com' }]);
  });

  it('treats a non-ok probe result as a mismatch, using the body as the actual value', async () => {
    const probe = fakeProbe(() => ({ status: 0, body: 'error: request timed out' }));
    const res = await verifyVersions(probe, ['10.0.0.1'], { expected: '30412', versionPath: '/version' });
    expect(res?.allMatch).toBe(false);
    expect(res?.results[0]?.actual).toBe('HTTP 0: error: request timed out');
  });

  it('truncates non-ok response bodies to 120 characters in the actual value', async () => {
    const longBody = 'x'.repeat(150);
    const probe = fakeProbe(() => ({ status: 500, body: longBody }));
    const res = await verifyVersions(probe, ['10.0.0.1'], { expected: '30412', versionPath: '/version' });
    expect(res?.allMatch).toBe(false);
    expect(res?.results[0]?.actual).toBe(`HTTP 500: ${'x'.repeat(120)}`);
  });

  it('polls a host until its version matches, then reports match', async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      return { ok: true, status: 200, body: calls >= 3 ? '30412' : '30411' };
    };
    const res = await verifyVersions(probe as never, ['10.0.0.1'],
      { expected: '30412', versionPath: '/version', retryCeilingMs: 5000, retryIntervalMs: 1 });
    expect(res.allMatch).toBe(true);
    expect(res.results[0]).toEqual({ server: '10.0.0.1', match: true, actual: '30412' });
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('reports mismatch after the ceiling if it never matches', async () => {
    const probe = async () => ({ ok: true, status: 200, body: '30411' });
    const res = await verifyVersions(probe as never, ['10.0.0.1'],
      { expected: '30412', versionPath: '/version', retryCeilingMs: 5, retryIntervalMs: 1 });
    expect(res.allMatch).toBe(false);
    expect(res.results[0]?.actual).toBe('30411');
  });

  it('guarantees exactly one result per host even with a ceiling of 0', async () => {
    const probe = async () => ({ ok: true, status: 200, body: '30411' });
    const res = await verifyVersions(probe as never, ['h1', 'h2'],
      { expected: 'v', versionPath: '/version', retryCeilingMs: 0, retryIntervalMs: 1 });
    expect(res.results.length).toBe(2);
    expect(res.results.map(r => r.server)).toEqual(['h1', 'h2']);
  });
});
