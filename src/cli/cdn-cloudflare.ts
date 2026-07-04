// Path: src/cli/cdn-cloudflare.ts
import type { RunSummary } from './types.js';
import { HTTP_TIMEOUT_MS } from './constants.js';
import { probeVersion } from './http-probe.js';

export async function purgeCloudflare(
  fetchImpl: typeof fetch,
  opts: { zoneId: string; apiToken: string; purge: 'everything' | string[] }
): Promise<{ ok: boolean; detail?: string }> {
  const body = opts.purge === 'everything' ? { purge_everything: true } : { files: opts.purge };
  try {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${opts.zoneId}/purge_cache`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${opts.apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function verifyVersions(
  probe: typeof probeVersion,
  hosts: string[],
  opts: {
    expected: string;
    versionPath: string;
    hostHeader?: string;
    retryCeilingMs?: number;
    retryIntervalMs?: number;
  }
): Promise<RunSummary['verify']> {
  // No retryCeilingMs at all means "single probe, no polling" (the caller opted
  // out of retry semantics entirely). Passing retryCeilingMs — even 0 — opts
  // into the polling contract, which always yields exactly one result per host.
  const retryCeilingMs = opts.retryCeilingMs ?? 0;
  const retryIntervalMs = opts.retryIntervalMs ?? 500;
  const results: { server: string; match: boolean; actual: string }[] = [];

  for (const host of hosts) {
    // A ceiling of 0 (or less) still permits exactly one attempt: the deadline
    // check happens *after* the first probe, not before it, so every host is
    // guaranteed to push exactly one result regardless of the ceiling value.
    const deadline = Date.now() + retryCeilingMs;
    let res = await probe(host, opts.versionPath, { hostHeader: opts.hostHeader, timeoutMs: HTTP_TIMEOUT_MS });

    while (!(res.ok && res.body.trim() === opts.expected) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
      res = await probe(host, opts.versionPath, { hostHeader: opts.hostHeader, timeoutMs: HTTP_TIMEOUT_MS });
    }

    if (!res.ok) {
      const truncated = res.body.slice(0, 120).trim();
      results.push({ server: host, match: false, actual: `HTTP ${res.status}${truncated ? ': ' + truncated : ''}` });
      continue;
    }

    const actual = res.body.trim();
    results.push({ server: host, match: actual === opts.expected, actual });
  }

  return { allMatch: results.every(r => r.match), results };
}
