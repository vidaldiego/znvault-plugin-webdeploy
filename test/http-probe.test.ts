import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeVersion } from '../src/cli/http-probe.js';

let server: http.Server | undefined;

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    server = http.createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server!.address() as AddressInfo).port);
    });
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('probeVersion', () => {
  it('sends the overridden Host header to the server — the whole point of the fix (fetch/undici cannot do this)', async () => {
    let receivedHost = '';
    const port = await startServer((req, res) => {
      receivedHost = req.headers.host ?? '';
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('30412');
    });

    const res = await probeVersion(`127.0.0.1:${port}`, '/version', { hostHeader: 'my.zincapp.com', timeoutMs: 2000 });

    expect(receivedHost).toBe('my.zincapp.com');
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body).toBe('30412');
  });

  it('falls back to the natural Host header (host:port) when no override is given', async () => {
    let receivedHost = '';
    const port = await startServer((req, res) => {
      receivedHost = req.headers.host ?? '';
      res.writeHead(200);
      res.end('ok');
    });

    await probeVersion(`127.0.0.1:${port}`, '/version', { timeoutMs: 2000 });

    expect(receivedHost).toBe(`127.0.0.1:${port}`);
  });

  it('resolves (does not throw) with ok:false on connection refused', async () => {
    // Port 1 on localhost should reliably refuse connections without a running server.
    const res = await probeVersion('127.0.0.1:1', '/version', { timeoutMs: 2000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.body).toContain('error');
  });

  it('resolves with ok:false and a non-2xx status when the server responds with an error', async () => {
    const port = await startServer((_req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    const res = await probeVersion(`127.0.0.1:${port}`, '/version', { timeoutMs: 2000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(res.body).toBe('boom');
  });
});
