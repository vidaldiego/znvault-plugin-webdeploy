// Path: src/cli/health.ts
import type { Exec, HealthCheckSpec, HostConnection } from './types.js';

type Status = 'OK' | 'WARN' | 'FAIL';

interface ParsedLine { status: Status; detail: string }

/**
 * Shell fragment for one check: computes STATUS (OK|WARN|FAIL) and a detail
 * string, then emits exactly one `printf 'IDX|STATUS|DETAIL\n'` line.
 * Detail must not contain '|' or newlines — each fragment guards for that
 * where the underlying value could plausibly contain one.
 */
function checkFragment(idx: number, spec: HealthCheckSpec): string {
  switch (spec.type) {
    case 'systemd':
      return [
        `ST=$(sudo systemctl is-active ${spec.unit} 2>/dev/null)`,
        `if [ "$ST" = "active" ]; then printf '%s|OK|%s\\n' ${idx} "$ST"`,
        `else printf '%s|FAIL|%s\\n' ${idx} "\${ST:-unknown}"; fi`,
      ].join('; ');

    case 'http': {
      const expect = spec.expectStatus ?? 200;
      return [
        `CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 ${spec.url} || echo "timeout")`,
        `if [ "$CODE" = "${expect}" ]; then printf '%s|OK|%s\\n' ${idx} "$CODE"`,
        `else printf '%s|FAIL|%s\\n' ${idx} "$CODE"; fi`,
      ].join('; ');
    }

    case 'pm2':
      // Detail carries app|online|total so parseHealthOutput can rebuild the
      // exact "N/M instances online" / "not found" / "failed to parse" text
      // without re-deriving it in shell.
      return [
        `JLIST=$(pm2 jlist 2>/dev/null)`,
        `printf '%s|PM2|%s\\n' ${idx} "$JLIST"`,
      ].join('; ');

    case 'ports': {
      const ports = spec.ports;
      return [
        `RESP=0`,
        ...ports.map(p =>
          `CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:${p}/ || echo "timeout"); ` +
          `if [ "$CODE" != "timeout" ] && [ "$CODE" -lt 500 ] 2>/dev/null; then RESP=$((RESP+1)); fi`
        ),
        `if [ "$RESP" -eq ${ports.length} ]; then printf '%s|OK|%s\\n' ${idx} "$RESP"` +
          `; elif [ "$RESP" -gt 0 ]; then printf '%s|WARN|%s\\n' ${idx} "$RESP"` +
          `; else printf '%s|FAIL|%s\\n' ${idx} "$RESP"; fi`,
      ].join('; ');
    }

    case 'file':
      return `if test -f ${spec.path}; then printf '%s|OK|exists\\n' ${idx}; else printf '%s|FAIL|missing\\n' ${idx}; fi`;

    case 'disk': {
      const warnAt = spec.warnAt ?? 80;
      const failAt = spec.failAt ?? 90;
      return [
        `PCT=$(df -h / | tail -1 | awk '{print $5}' | tr -d '%')`,
        `if ! echo "$PCT" | grep -Eq '^[0-9]+$'; then printf '%s|FAIL|unreadable\\n' ${idx}`,
        `elif [ "$PCT" -ge ${failAt} ]; then printf '%s|FAIL|%s\\n' ${idx} "$PCT"`,
        `elif [ "$PCT" -ge ${warnAt} ]; then printf '%s|WARN|%s\\n' ${idx} "$PCT"`,
        `else printf '%s|OK|%s\\n' ${idx} "$PCT"; fi`,
      ].join('; ');
    }

    case 'memory': {
      const warnAt = spec.warnAt ?? 80;
      const failAt = spec.failAt ?? 90;
      return [
        `PCT=$(free -m | grep Mem | awk '{printf "%.0f", $3/$2 * 100}')`,
        `if ! echo "$PCT" | grep -Eq '^[0-9]+$'; then printf '%s|FAIL|unreadable\\n' ${idx}`,
        `elif [ "$PCT" -ge ${failAt} ]; then printf '%s|FAIL|%s\\n' ${idx} "$PCT"`,
        `elif [ "$PCT" -ge ${warnAt} ]; then printf '%s|WARN|%s\\n' ${idx} "$PCT"`,
        `else printf '%s|OK|%s\\n' ${idx} "$PCT"; fi`,
      ].join('; ');
    }
  }
}

/** Composes one shell script that runs every check and emits one `idx|STATUS|detail` line per check. */
export function buildHealthScript(specs: HealthCheckSpec[]): string {
  return specs.map((spec, idx) => `(${checkFragment(idx, spec)})`).join('\n');
}

function parsePm2Detail(jlist: string, app: string): { status: Status; line: string } {
  try {
    const apps = JSON.parse(jlist) as { name: string; pm2_env: { status: string } }[];
    const mine = apps.filter(a => a.name === app);
    if (mine.length === 0) return { status: 'FAIL', line: `❌ PM2: ${app} not found` };
    const online = mine.filter(a => a.pm2_env.status === 'online').length;
    if (online === mine.length) return { status: 'OK', line: `✅ PM2: ${online}/${mine.length} instances online` };
    return { status: online === 0 ? 'FAIL' : 'WARN', line: `${online === 0 ? '❌' : '⚠️'} PM2: ${online}/${mine.length} instances online` };
  } catch {
    return { status: 'FAIL', line: `❌ PM2: failed to parse status` };
  }
}

/** Rebuilds the exact result line + failure flag for one spec from its parsed `STATUS|detail`. */
function renderResult(spec: HealthCheckSpec, parsed: ParsedLine): { line: string; failed: boolean } {
  const { status, detail } = parsed;
  switch (spec.type) {
    case 'systemd':
      return status === 'OK'
        ? { line: `✅ ${spec.unit}: active`, failed: false }
        : { line: `❌ ${spec.unit}: ${detail || 'unknown'}`, failed: true };

    case 'http':
      return status === 'OK'
        ? { line: `✅ HTTP ${spec.url}: ${detail}`, failed: false }
        : { line: `❌ HTTP ${spec.url}: ${detail}`, failed: true };

    case 'pm2': {
      const { status: pmStatus, line } = parsePm2Detail(detail, spec.app);
      return { line, failed: pmStatus === 'FAIL' };
    }

    case 'ports': {
      const total = spec.ports.length;
      if (status === 'OK') return { line: `✅ Backend ports: all ${total} responding`, failed: false };
      if (status === 'WARN') return { line: `⚠️ Backend ports: ${detail}/${total} responding`, failed: false };
      return { line: `❌ Backend ports: none responding`, failed: true };
    }

    case 'file':
      return status === 'OK'
        ? { line: `✅ ${spec.path}: present`, failed: false }
        : { line: `❌ ${spec.path}: missing`, failed: true };

    case 'disk':
      if (status === 'FAIL' && detail === 'unreadable') return { line: `❌ Disk usage: unreadable`, failed: true };
      if (status === 'OK') return { line: `✅ Disk usage: ${detail}%`, failed: false };
      if (status === 'WARN') return { line: `⚠️ Disk usage: ${detail}% (warning)`, failed: false };
      return { line: `❌ Disk usage: ${detail}% (critical)`, failed: true };

    case 'memory':
      if (status === 'FAIL' && detail === 'unreadable') return { line: `❌ Memory usage: unreadable`, failed: true };
      if (status === 'OK') return { line: `✅ Memory usage: ${detail}%`, failed: false };
      if (status === 'WARN') return { line: `⚠️ Memory usage: ${detail}% (warning)`, failed: false };
      // Memory never fails (failHard=false): the fail threshold still renders as a warning.
      return { line: `⚠️ Memory usage: ${detail}% (critical)`, failed: false };
  }
}

/**
 * Matches exactly the `IDX|STATUS|DETAIL` shape our own shell fragments emit
 * (STATUS anchored to one of the four literal tokens we ever print). A stray
 * stdout line that merely starts with digits and a pipe — e.g. leaked output
 * from a check's own command — no longer parses as a result line and
 * clobbers a real index (last-wins, pre-fix).
 */
const RESULT_LINE_RE = /^(\d+)\|(OK|WARN|FAIL|PM2)\|/;

/** Parses `buildHealthScript`'s stdout back into the same result strings/success flag as the per-check functions. */
export function parseHealthOutput(specs: HealthCheckSpec[], stdout: string): { success: boolean; results: string[] } {
  const lines = stdout.split('\n').filter(l => l.trim().length > 0);
  const byIndex = new Map<number, ParsedLine>();
  for (const line of lines) {
    const match = RESULT_LINE_RE.exec(line);
    if (!match) continue;
    const idx = parseInt(match[1]!, 10);
    const status = match[2] as Status;
    const detail = line.slice(match[0].length);
    byIndex.set(idx, { status, detail });
  }

  const results: string[] = [];
  let ok = true;
  specs.forEach((spec, idx) => {
    const parsed = byIndex.get(idx) ?? { status: 'FAIL' as Status, detail: '' };
    const { line, failed } = renderResult(spec, parsed);
    results.push(line);
    if (failed) ok = false;
  });

  return { success: ok, results };
}

export async function runHealthChecks(
  exec: Exec,
  conn: HostConnection,
  specs: HealthCheckSpec[]
): Promise<{ success: boolean; results: string[] }> {
  if (specs.length === 0) return { success: true, results: [] };
  const res = await exec(conn, buildHealthScript(specs));
  return parseHealthOutput(specs, res.stdout);
}
