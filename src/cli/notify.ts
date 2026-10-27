// Path: src/cli/notify.ts
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { WEBDEPLOY_CONFIG_DIR } from './constants.js';
import { join, resolve } from 'node:path';
import type { RunSummary } from './types.js';
import { HTTP_TIMEOUT_MS } from './constants.js';

export async function sendWebhook(
  fetchImpl: typeof fetch,
  url: string,
  summary: RunSummary,
  redact: (s: string) => string
): Promise<void> {
  const serverLines = summary.hosts.map(h => {
    if (h.success && h.healthOk) return `  ✅ ${h.host}`;
    if (h.success) return `  ❌ ${h.host}: health gate failed`;
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
  log: (l: string) => void,
  cacheDir: string = join(WEBDEPLOY_CONFIG_DIR, 'help-cache')
): Promise<{ success: boolean; skipped?: boolean }> {
  try {
    if (!existsSync(opts.contentDir)) { log(`help sync: no dir ${opts.contentDir}, skipping`); return { success: true, skipped: true }; }
    const files = readdirSync(opts.contentDir).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) { log('help sync: no .md files, skipping'); return { success: true, skipped: true }; }
    const modules = files.map(f => ({
      module: f.replace(/\.md$/, ''),
      markdown: readFileSync(join(opts.contentDir, f), 'utf-8'),
    }));
    const body = JSON.stringify({ modules });
    const digest = createHash('sha256').update(body).digest('hex');
    const identity = createHash('sha256').update(JSON.stringify([opts.url, resolve(opts.contentDir)])).digest('hex');
    const stamp = join(cacheDir, `${identity}.sha256`);
    try {
      if (readFileSync(stamp, 'utf8').trim() === digest) { log('help sync: content unchanged, skipping'); return { success: true, skipped: true }; }
    } catch { /* no successful previous sync */ }
    const res = await fetchImpl(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Deploy-Key': opts.key },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const temporary = `${stamp}.${randomUUID()}`;
      try { writeFileSync(temporary, digest + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, stamp); }
      finally { rmSync(temporary, { force: true }); }
    }
    log(res.ok ? `help sync: ${files.length} modules synced` : `help sync: HTTP ${res.status} (non-blocking)`);
    return { success: res.ok };
  } catch (err) {
    log(`help sync failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`);
    return { success: false };
  }
}
