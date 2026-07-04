// Path: src/cli/secret-resolver.ts
import type { CLIPluginContext } from './plugin-types.js';
import type { WebDeployConfig } from './types.js';

type VaultClient = CLIPluginContext['client'];

export type ParsedRef =
  | { kind: 'alias'; alias: string; field?: string }
  | { kind: 'plain'; value: string };

export function parseSecretRef(s: string): ParsedRef {
  if (s.startsWith('literal:')) return { kind: 'plain', value: s.slice('literal:'.length) };
  if (!s.startsWith('alias:')) return { kind: 'plain', value: s };
  const body = s.slice('alias:'.length);
  const lastSlash = body.lastIndexOf('/');
  const lastSegment = body.slice(lastSlash + 1);
  const dot = lastSegment.lastIndexOf('.');
  if (dot === -1) return { kind: 'alias', alias: body };
  return {
    kind: 'alias',
    alias: body.slice(0, lastSlash + 1) + lastSegment.slice(0, dot),
    field: lastSegment.slice(dot + 1),
  };
}

/** Registry of resolved secret values; redact() masks all of them in any string. */
export class Redactor {
  private values: string[] = [];

  /**
   * Registers `value` plus the transformed representations it's likely to
   * appear as in logs/JSON output, so redact() catches them too:
   *  - each line of a multi-line value (length > 3, to avoid mass-redacting
   *    short/common substrings like blank lines or "--"), since a multi-line
   *    secret (e.g. a PEM key) is often logged one line at a time; and
   *  - the JSON-escaped form (as produced by JSON.stringify), for secrets
   *    embedded in a JSON.stringify'd document (e.g. --json summaries),
   *    when escaping actually changes the string (e.g. an embedded quote).
   * Both treatments compose: an escaped multi-line value also has each of
   * its escaped lines registered.
   */
  add(value: string): void {
    if (value.length === 0) return;
    this.registerCandidate(value);
  }

  private registerCandidate(value: string): void {
    this.values.push(value);

    const lines = value.split('\n');
    if (lines.length > 1) {
      for (const line of lines) {
        if (line.length > 3) this.values.push(line);
      }
    }

    const esc = JSON.stringify(value).slice(1, -1);
    if (esc !== value) {
      this.values.push(esc);
      const escLines = esc.split('\n');
      if (escLines.length > 1) {
        for (const line of escLines) {
          if (line.length > 3) this.values.push(line);
        }
      }
    }
  }

  redact(text: string): string {
    let out = text;
    for (const v of [...this.values].sort((a, b) => b.length - a.length)) {
      out = out.split(v).join('[REDACTED]');
    }
    return out;
  }
}

interface DecryptedSecret { id: string; alias: string; data: Record<string, unknown> | string }

export async function resolveRef(client: VaultClient, ref: string, redactor: Redactor): Promise<string> {
  const parsed = parseSecretRef(ref);
  if (parsed.kind === 'plain') return parsed.value;

  const meta = await client.get<{ id: string }>(`/v1/secrets/alias/${encodeURIComponent(parsed.alias)}`);
  const secret = await client.post<DecryptedSecret>(`/v1/secrets/${meta.id}/decrypt`, {});
  const data = secret.data;

  let value: unknown;
  if (parsed.field !== undefined) {
    value = typeof data === 'object' && data !== null ? (data as Record<string, unknown>)[parsed.field] : undefined;
    if (value === undefined) {
      const available = typeof data === 'object' && data !== null ? Object.keys(data).join(', ') : typeof data;
      throw new Error(`Field '${parsed.field}' not found in secret '${parsed.alias}' (available: ${available})`);
    }
  } else if (typeof data === 'string') {
    value = data;
  } else if (typeof data.content === 'string') {
    value = Buffer.from(data.content, 'base64').toString('utf-8');
  } else if (data.value !== undefined) {
    value = data.value;
  } else {
    throw new Error(`Secret '${parsed.alias}' has no 'value'/'content'; specify a field: alias:${parsed.alias}.<field>`);
  }

  const str = String(value);
  redactor.add(str);
  return str;
}

/** Deep-copy cfg with all alias: refs resolved. Never mutates the input. */
export async function resolveConfigSecrets(
  client: VaultClient,
  cfg: WebDeployConfig,
  redactor: Redactor
): Promise<WebDeployConfig> {
  const out: WebDeployConfig = JSON.parse(JSON.stringify(cfg)) as WebDeployConfig;
  const r = (ref: string) => resolveRef(client, ref, redactor);

  if (out.app?.env) {
    for (const [k, v] of Object.entries(out.app.env)) out.app.env[k] = await r(v);
  }
  if (out.app?.files) {
    for (const [k, v] of Object.entries(out.app.files)) out.app.files[k] = await r(v);
  }
  if (out.cdn) {
    out.cdn.zoneId = await r(out.cdn.zoneId);
    out.cdn.apiToken = await r(out.cdn.apiToken);
  }
  if (out.notify?.webhook !== undefined) out.notify.webhook = await r(out.notify.webhook);
  if (out.notify?.helpSync) out.notify.helpSync.key = await r(out.notify.helpSync.key);

  return out;
}
