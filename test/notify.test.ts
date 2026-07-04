import { describe, it, expect } from 'vitest';
import { sendWebhook } from '../src/cli/notify.js';
import type { RunSummary } from '../src/cli/types.js';

function fakeFetch(onRequest: (url: string, init?: RequestInit) => void) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    onRequest(String(url), init);
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
}

describe('sendWebhook', () => {
  it('applies redact() to the fully composed text before POSTing, masking secrets in host errors and warnings', async () => {
    const SECRET = 'zn-secret-abc123';
    const summary: RunSummary = {
      config: 'prod',
      build: '30412',
      hosts: [
        { host: 'h1', success: false, error: `connection failed, token=${SECRET}`, healthResults: [], healthOk: false },
      ],
      warnings: [`upstream rejected credential ${SECRET}`],
      success: false,
    };

    let capturedBody = '';
    const f = fakeFetch((_url, init) => { capturedBody = String(init?.body); });
    const redact = (s: string) => s.split(SECRET).join('[REDACTED]');

    await sendWebhook(f, 'https://hooks.example/x', summary, redact);

    expect(capturedBody).not.toContain(SECRET);
    const parsed = JSON.parse(capturedBody) as { text: string };
    expect(parsed.text).toContain('[REDACTED]');
    expect(parsed.text).not.toContain(SECRET);
  });

  it('passes through text unchanged when redact is the identity function', async () => {
    const summary: RunSummary = {
      config: 'prod', build: '1', hosts: [{ host: 'h1', success: true, healthResults: [], healthOk: true }],
      warnings: [], success: true,
    };
    let capturedBody = '';
    const f = fakeFetch((_url, init) => { capturedBody = String(init?.body); });
    await sendWebhook(f, 'https://hooks.example/x', summary, s => s);
    const parsed = JSON.parse(capturedBody) as { text: string };
    expect(parsed.text).toContain('h1');
    expect(parsed.text).toContain('Build 1');
  });
});
