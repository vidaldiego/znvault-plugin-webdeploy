// Path: src/cli/notify.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunSummary } from './types.js';
import { HTTP_TIMEOUT_MS } from './constants.js';

export async function sendWebhook(
  fetchImpl: typeof fetch,
  url: string,
  summary: RunSummary,
  redact: (s: string) => string
): Promise<void> {
  const serverLines = summary.hosts.map(h => {
    if (h.success) return `  ✅ ${h.host}`;
    if (h.skipped) return `  ⏭️ ${h.host} (skipped)`;
    return `  ❌ ${h.host}: ${h.error ?? 'failed'}`;
  }).join('\n');
  const status = summary.success && summary.warnings.length === 0 ? '🎉 Success' : '⚠️ Issues detected';
  const text = redact([
    `*Deploy ${summary.config} — Build ${summary.build}*`,
    `Status: ${status}`,
    'Servers:', serverLines,
    summary.warnings.length ? `Warnings:\n${summary.warnings.map(w => `  ⚠️ ${w}`).join('\n')}` : '',
  ].filter(Boolean).join('\n'));

  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
  } catch { /* non-blocking */ }
}

export async function syncHelp(
  fetchImpl: typeof fetch,
  opts: { url: string; key: string; contentDir: string },
  log: (l: string) => void
): Promise<void> {
  try {
    if (!existsSync(opts.contentDir)) { log(`help sync: no dir ${opts.contentDir}, skipping`); return; }
    const files = readdirSync(opts.contentDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) { log('help sync: no .md files, skipping'); return; }
    const modules = files.map(f => ({
      module: f.replace(/\.md$/, ''),
      markdown: readFileSync(join(opts.contentDir, f), 'utf-8'),
    }));
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Deploy-Key': opts.key },
      body: JSON.stringify({ modules }),
      signal: AbortSignal.timeout(15_000),
    });
    log(res.ok ? `help sync: ${files.length} modules synced` : `help sync: HTTP ${res.status} (non-blocking)`);
  } catch (err) {
    log(`help sync failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
  }
}
