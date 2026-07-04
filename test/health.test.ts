import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { runHealthChecks, buildHealthScript, parseHealthOutput } from '../src/cli/health.js';
import type { HealthCheckSpec, HostConnection, ExecResult } from '../src/cli/types.js';

const conn: HostConnection = { host: 'h', port: 22, user: 'u', keyPath: 'k', certPath: 'c' };

/**
 * `runHealthChecks` now issues exactly ONE exec call: the composed script
 * from `buildHealthScript`. This fake simulates that single remote round
 * trip by resolving, per spec, which canned raw command output applies
 * (same substring-matching semantics the pre-batching per-check fakeExec
 * used) and deriving the `idx|STATUS|detail` line a real shell would have
 * printed — then joins those lines into the one stdout blob
 * `parseHealthOutput` reads. `buildHealthScript`/`parseHealthOutput` are
 * covered directly (and more granularly) by the dedicated describe block
 * below; this keeps `runHealthChecks`'s existing black-box tests exercising
 * the real exec-once wiring without spawning an actual shell.
 */
function fakeExec(specs: HealthCheckSpec[], answers: Record<string, string | { code: number; out: string }>) {
  // Mirrors the pre-batching fakeExec's `command.includes(needle)` matching:
  // find the first answer key that is a substring of the given probe text
  // (e.g. the sub-command a real shell fragment would have run).
  function rawFor(probe: string): string {
    for (const [needle, answer] of Object.entries(answers)) {
      if (probe.includes(needle)) return typeof answer === 'string' ? answer : answer.out;
    }
    return '';
  }

  function lineFor(idx: number, spec: HealthCheckSpec): string {
    switch (spec.type) {
      case 'systemd': {
        const status = rawFor(`is-active ${spec.unit}`).trim();
        return status === 'active' ? `${idx}|OK|${status}` : `${idx}|FAIL|${status || 'unknown'}`;
      }
      case 'http': {
        const code = rawFor(spec.url).trim();
        const expect = String(spec.expectStatus ?? 200);
        return code === expect ? `${idx}|OK|${code}` : `${idx}|FAIL|${code}`;
      }
      case 'pm2':
        return `${idx}|PM2|${rawFor('pm2 jlist')}`;
      case 'ports': {
        const total = spec.ports.length;
        const responding = spec.ports.filter(p => {
          const code = rawFor(`:${p}/`).trim();
          return code !== 'timeout' && code !== '' && parseInt(code, 10) < 500;
        }).length;
        if (responding === total) return `${idx}|OK|${responding}`;
        if (responding > 0) return `${idx}|WARN|${responding}`;
        return `${idx}|FAIL|${responding}`;
      }
      case 'file': {
        const out = rawFor(`test -f ${spec.path}`).trim();
        return out === 'exists' ? `${idx}|OK|exists` : `${idx}|FAIL|missing`;
      }
      case 'disk': {
        const warnAt = spec.warnAt ?? 80;
        const failAt = spec.failAt ?? 90;
        const raw = rawFor('df -h').trim();
        const pct = parseInt(raw, 10);
        if (Number.isNaN(pct)) return `${idx}|FAIL|unreadable`;
        if (pct >= failAt) return `${idx}|FAIL|${pct}`;
        if (pct >= warnAt) return `${idx}|WARN|${pct}`;
        return `${idx}|OK|${pct}`;
      }
      case 'memory': {
        const warnAt = spec.warnAt ?? 80;
        const failAt = spec.failAt ?? 90;
        const raw = rawFor('free -m').trim();
        const pct = parseInt(raw, 10);
        if (Number.isNaN(pct)) return `${idx}|FAIL|unreadable`;
        if (pct >= failAt) return `${idx}|FAIL|${pct}`;
        if (pct >= warnAt) return `${idx}|WARN|${pct}`;
        return `${idx}|OK|${pct}`;
      }
    }
  }

  return async (_c: HostConnection, command: string): Promise<ExecResult> => {
    // runHealthChecks only ever issues the composed batch script for these specs.
    const expectedScript = buildHealthScript(specs);
    if (command !== expectedScript) {
      return { code: 1, stdout: '', stderr: `unexpected command: ${command}` };
    }
    const stdout = specs.map((spec, idx) => lineFor(idx, spec)).join('\n');
    return { code: 0, stdout, stderr: '' };
  };
}

const PM2_OK = JSON.stringify([
  { name: 'www', pm2_env: { status: 'online' } },
  { name: 'www', pm2_env: { status: 'online' } },
]);

describe('runHealthChecks', () => {
  it('passes when everything is healthy', async () => {
    const specs: HealthCheckSpec[] = [
      { type: 'systemd', unit: 'nginx' },
      { type: 'http', url: 'http://localhost/service-status' },
      { type: 'pm2', app: 'www' },
      { type: 'ports', ports: [3000, 3001] },
      { type: 'file', path: 'app/.env' },
      { type: 'disk' },
      { type: 'memory' },
    ];
    const res = await runHealthChecks(fakeExec(specs, {
      'is-active nginx': 'active\n',
      'service-status': '200',
      'pm2 jlist': PM2_OK,
      ':3000/': '200', ':3001/': '200',
      'df -h': '42\n',
      'free -m': '55',
      'test -f app/.env': 'exists\n',
    }), conn, specs);
    expect(res.success).toBe(true);
    expect(res.results.every(r => r.startsWith('✅'))).toBe(true);
  });

  it('fails when nginx is inactive', async () => {
    const specs: HealthCheckSpec[] = [{ type: 'systemd', unit: 'nginx' }];
    const res = await runHealthChecks(fakeExec(specs, { 'is-active nginx': 'inactive\n' }), conn, specs);
    expect(res.success).toBe(false);
    expect(res.results[0]).toMatch(/^❌/);
  });

  it('warns (not fails) when some but not all ports respond', async () => {
    const specs: HealthCheckSpec[] = [{ type: 'ports', ports: [3000, 3001] }];
    const res = await runHealthChecks(fakeExec(specs, { ':3000/': '200', ':3001/': 'timeout' }), conn, specs);
    expect(res.success).toBe(true);
    expect(res.results[0]).toMatch(/^⚠️/);
  });

  it('fails disk at >=90% and warns at >=80%', async () => {
    const specs: HealthCheckSpec[] = [{ type: 'disk' }];
    const warn = await runHealthChecks(fakeExec(specs, { 'df -h': '85' }), conn, specs);
    expect(warn.success).toBe(true);
    expect(warn.results[0]).toMatch(/^⚠️/);
    const fail = await runHealthChecks(fakeExec(specs, { 'df -h': '95' }), conn, specs);
    expect(fail.success).toBe(false);
  });

  it('returns success with no results when there are no checks', async () => {
    const res = await runHealthChecks(fakeExec([], {}), conn, []);
    expect(res).toEqual({ success: true, results: [] });
  });
});

describe('buildHealthScript / parseHealthOutput', () => {
  const specs = [
    { type: 'systemd', unit: 'nginx' },
    { type: 'disk' },
  ] as const;

  it('builds one script covering all checks', () => {
    const script = buildHealthScript(specs as never);
    expect(script).toContain('systemctl is-active nginx');
    expect(script).toContain('df -h');
    // single script, emits index|STATUS|detail lines
    expect(script).toMatch(/\|/);
  });

  it('parses OK/WARN/FAIL lines into emoji results with any-FAIL failing', () => {
    const stdout = '0|OK|active\n1|WARN|85';
    const parsed = parseHealthOutput(specs as never, stdout);
    expect(parsed.success).toBe(true);           // WARN does not fail
    expect(parsed.results[0]).toMatch(/^✅/);
    expect(parsed.results[1]).toMatch(/^⚠️/);

    const failed = parseHealthOutput(specs as never, '0|FAIL|inactive\n1|OK|40');
    expect(failed.success).toBe(false);
    expect(failed.results[0]).toMatch(/^❌/);
  });

  it('treats a missing line for a spec as a FAIL (defensive default)', () => {
    const parsed = parseHealthOutput(specs as never, '0|OK|active');
    expect(parsed.success).toBe(false);
    expect(parsed.results[1]).toMatch(/^❌/);
  });

  it('ignores a stray line shaped like "<digits>|<junk>|..." (not a real OK/WARN/FAIL/PM2 status token), instead of letting it clobber a real index (last-wins bug)', () => {
    // A stray line with two pipes but a non-status second field (e.g. leaked
    // output from a check's own command that happens to start with digits
    // and contain pipes) must NOT match the tightened
    // `^\d+\|(OK|WARN|FAIL|PM2)\|` shape, so it can't overwrite the real
    // result recorded for index 0 that appears earlier in stdout. Pre-fix,
    // any two-pipe line parsed unconditionally and "last wins" — this exact
    // stray line would have clobbered index 0's real OK with a bogus status.
    const stdout = '0|OK|active\n0|not-a-status|whatever\n1|WARN|85';
    const parsed = parseHealthOutput(specs as never, stdout);
    expect(parsed.success).toBe(true);
    expect(parsed.results[0]).toMatch(/^✅/);
    expect(parsed.results[1]).toMatch(/^⚠️/);
  });
});

/**
 * Real-shell coverage for the shell/TS boundary (review Finding 3).
 *
 * Everything above exercises `buildHealthScript`'s output through a hand-written
 * TS reimplementation of the thresholds (`fakeExec`'s `lineFor`) — it never runs
 * the actual bash the fragments compile to. A typo in the shell itself (e.g.
 * `-gt` swapped for `-ge` in the disk/memory threshold comparisons) would pass
 * every test above undetected, because the TS reimplementation would still
 * encode the *intended* threshold, not the shipped one.
 *
 * This block runs `buildHealthScript(specs)`'s literal output through a real
 * `/bin/sh`, with the external commands it shells out to (`df`, `curl`,
 * `systemctl`) replaced by shell FUNCTIONS defined in a harness prefix. Shell
 * function definitions shadow external binaries of the same name for the
 * remainder of that `sh -c` invocation, so the generated script's own
 * `if [ "$PCT" -ge 90 ]`-style comparisons are the ones actually evaluated —
 * this is the only way to catch a `-gt`/`-ge` (or similar operator) typo.
 */
describe('buildHealthScript against a real shell (shell/TS boundary)', () => {
  function runScript(specs: HealthCheckSpec[], harnessPrefix: string): string {
    const script = buildHealthScript(specs);
    return execFileSync('/bin/sh', ['-c', harnessPrefix + script], { encoding: 'utf8' });
  }

  describe('disk thresholds', () => {
    const specs: HealthCheckSpec[] = [{ type: 'disk' }];
    function dfStub(pct: number): string {
      return `df() { echo "Filesystem Size Used Avail Use% Mounted"; echo "/dev/root 50G 1G 1G ${pct}% /"; }\n`;
    }

    it('FAILs at 95% (>= 90 fail threshold)', () => {
      const out = runScript(specs, dfStub(95));
      expect(out.trim()).toBe('0|FAIL|95');
    });

    it('WARNs at 85% (>= 80 warn threshold, below fail)', () => {
      const out = runScript(specs, dfStub(85));
      expect(out.trim()).toBe('0|WARN|85');
    });

    it('is OK at 40% (below both thresholds)', () => {
      const out = runScript(specs, dfStub(40));
      expect(out.trim()).toBe('0|OK|40');
    });

    it('FAILs at exactly 90% — catches a >= vs > operator typo at the boundary', () => {
      const out = runScript(specs, dfStub(90));
      expect(out.trim()).toBe('0|FAIL|90');
    });
  });

  describe('ports', () => {
    const specs: HealthCheckSpec[] = [{ type: 'ports', ports: [3000, 3001] }];
    function curlStub(codes: Record<number, string>): string {
      const cases = Object.entries(codes)
        .map(([port, code]) => `    *":${port}/"*) echo "${code}" ;;`)
        .join('\n');
      return [
        `curl() {`,
        `  for a in "$@"; do :; done`,
        `  url="$a"`,
        `  case "$url" in`,
        cases,
        `    *) echo "timeout" ;;`,
        `  esac`,
        `}`,
        '',
      ].join('\n');
    }

    it('is OK when all ports respond', () => {
      const out = runScript(specs, curlStub({ 3000: '200', 3001: '200' }));
      expect(out.trim()).toBe('0|OK|2');
    });

    it('FAILs when no ports respond', () => {
      const out = runScript(specs, curlStub({ 3000: '500', 3001: '500' }));
      expect(out.trim()).toBe('0|FAIL|0');
    });
  });

  describe('systemd', () => {
    const specs: HealthCheckSpec[] = [{ type: 'systemd', unit: 'nginx' }];

    it('is OK when the unit is active', () => {
      const stub = `systemctl() { echo "active"; }\nsudo() { "$@"; }\n`;
      const out = runScript(specs, stub);
      expect(out.trim()).toBe('0|OK|active');
    });
  });
});
