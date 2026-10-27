import type { ValidatedPublication } from './publication.js';
import { Timings } from './timing.js';
import { readFileSync } from 'node:fs';
import type { Exec, HostConnection, RunSummary, WebDeployConfig } from './types.js';
import { runHealthChecks } from './health.js';
import { checkNginxListeners, digest, readNginxHash } from './nginx.js';
import { probeVersion } from './http-probe.js';
import { verifyVersions } from './cdn-cloudflare.js';
import { VERSION_VERIFY_CEILING_MS } from './constants.js';

export interface VerifyDeps {
  publication?: ValidatedPublication;
  verifyInventory?: (conn: HostConnection) => Promise<void>;
  exec: Exec;
  readNginxFile?: (path: string) => string;
  probeVersion?: typeof probeVersion;
  versionVerifyCeilingMs?: number;
}

/** Read-only capabilities deliberately exclude file writes, transfer, secrets,
 * notification and CDN mutation. A failed host never prevents the others being checked. */
export async function verifyDeploy(
  name: string,
  cfg: WebDeployConfig,
  conns: HostConnection[],
  expectedBuild: string,
  deps: VerifyDeps
): Promise<RunSummary> {
  if (!/^[1-9][0-9]*$/.test(expectedBuild)) throw new Error('expected-build must be a positive integer');
  if (!cfg.verify) throw new Error('verify configuration is required for exact version readback');
  if (!cfg.nginx?.config) throw new Error('managed nginx configuration is required for verification');
  if (!cfg.healthChecks?.length) throw new Error('healthChecks are required for verification');
  if (
    conns.length !== cfg.hosts.length ||
    cfg.hosts.some((h) => conns.filter((c) => c.host === h).length !== 1)
  )
    throw new Error('verify requires every configured host exactly once');
  const managed = cfg.nginx.config;
  const content = (deps.readNginxFile ?? ((path) => readFileSync(path, 'utf8')))(managed.localPath);
  const timing = new Timings();
  const summary: RunSummary = {
    timings: timing.entries,
    config: name,
    build: expectedBuild,
    hosts: [],
    warnings: [],
    success: false,
  };
  for (const conn of conns) {
    const health = await timing.measure('health', conn.host, () =>
      runHealthChecks(deps.exec, conn, cfg.healthChecks!, { readOnly: true }).catch(() => ({
        success: false,
        results: ['Health probe failed'],
      }))
    );
    let error: string | undefined;
    let artifactVerified = false;
    let nginxOk = false;
    if (deps.publication) {
      try {
        deps.publication.recheck();
        if (!deps.verifyInventory) throw new Error('Missing installed inventory verifier');
        await timing.measure('installed-inventory', conn.host, () => deps.verifyInventory!(conn));
        artifactVerified = true;
      } catch {
        error = 'Installed artifact inventory verification failed';
      }
    }
    try {
      await timing.measure('nginx-verify', conn.host, async () => {
        if ((await readNginxHash(deps.exec, conn, managed, { readOnly: true })) !== digest(content))
          throw new Error('managed nginx digest mismatch');
        await checkNginxListeners(deps.exec, conn, content, managed);
        nginxOk = true;
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    summary.hosts.push({
      host: conn.host,
      success: !error,
      artifactVerified,
      artifactSha256: artifactVerified ? deps.publication?.receipt.artifact.artifactSha256 : undefined,
      nginxOk,
      healthOk: health.success,
      healthResults: health.results,
      ...(error ? { error } : {}),
    });
  }
  summary.verify = await timing.measure('version', undefined, () =>
    verifyVersions(deps.probeVersion ?? probeVersion, cfg.hosts, {
      expected: expectedBuild,
      versionPath: cfg.verify!.versionPath,
      hostHeader: cfg.verify!.hostHeader,
      retryCeilingMs: deps.versionVerifyCeilingMs ?? VERSION_VERIFY_CEILING_MS,
    })
  );
  summary.success = summary.hosts.every((h) => h.success && h.healthOk) && summary.verify?.allMatch === true;
  return summary;
}
