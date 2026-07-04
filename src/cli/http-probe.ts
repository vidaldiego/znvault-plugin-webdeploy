// Path: src/cli/http-probe.ts
import * as http from 'node:http';

/**
 * Probe an HTTP endpoint with an optional vhost-routing Host header.
 *
 * Node's global `fetch` (undici) strips/ignores a caller-supplied `Host`
 * header — it always sends the Host derived from the request URL — so
 * `fetch` cannot be used to route to a specific vhost on a bare IP. This
 * probe uses `node:http` directly, which honors an explicit `Host` header,
 * to make vhost-routed version checks (verify/status) actually work.
 *
 * Never throws: connection errors and timeouts resolve to `{ ok: false, ... }`
 * with the error text folded into `body` so callers can surface it directly.
 */
export function probeVersion(
  host: string,
  path: string,
  opts: { hostHeader?: string; timeoutMs: number }
): Promise<{ ok: boolean; status: number; body: string }> {
  // `host` may be a bare hostname/IP (port defaults to 80, matching the old
  // `http://${host}${path}` fetch calls this replaces) or a "host:port" pair
  // (IPv4/hostname only — IPv6 literals aren't a shape used by this plugin's
  // WebDeployConfig.hosts). node:http needs host and port split, unlike a URL.
  const lastColon = host.lastIndexOf(':');
  const explicitPort = lastColon === -1 ? undefined : Number(host.slice(lastColon + 1));
  const hostname = lastColon === -1 || Number.isNaN(explicitPort) ? host : host.slice(0, lastColon);
  const port = explicitPort !== undefined && !Number.isNaN(explicitPort) ? explicitPort : 80;

  return new Promise(resolve => {
    const req = http.request(
      {
        host: hostname,
        port,
        path,
        method: 'GET',
        headers: opts.hostHeader ? { Host: opts.hostHeader } : {},
        timeout: opts.timeoutMs,
      },
      res => {
        let body = '';
        res.on('data', chunk => { body += String(chunk); });
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, body });
        });
        res.on('error', err => {
          resolve({ ok: false, status: res.statusCode ?? 0, body: `error: ${err.message}` });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: 'error: request timed out' });
    });
    req.on('error', err => {
      resolve({ ok: false, status: 0, body: `error: ${err.message}` });
    });
    req.end();
  });
}
