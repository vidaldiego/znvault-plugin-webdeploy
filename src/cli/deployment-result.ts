import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RunSummary } from './types.js';
import { sha256, type ValidatedPublication } from './publication.js';

/** Fixed, public evidence only. Never copy logs, warnings, config or errors. */
export function writeDeploymentResult(
  publication: ValidatedPublication,
  operation: 'run' | 'verify',
  startedAt: string,
  summary: RunSummary,
  attemptId: string = randomUUID()
): { path: string; sha256: string } {
  validateAttemptId(attemptId);
  const { receipt, cfg } = publication;
  if (summary.build !== receipt.build) throw new Error('Result build identity mismatch');
  if (
    summary.hosts.some((h) => !cfg.hosts.includes(h.host)) ||
    new Set(summary.hosts.map((h) => h.host)).size !== summary.hosts.length
  )
    throw new Error('Invalid result host coverage');
  const hosts = cfg.hosts.map((host) => {
    const found = summary.hosts.find((h) => h.host === host);
    const artifactVerified =
      found?.artifactVerified === true && found.artifactSha256 === receipt.artifact.artifactSha256;
    return {
      host,
      artifactVerified,
      artifactSha256: artifactVerified ? receipt.artifact.artifactSha256 : null,
      healthOk: found?.healthOk === true,
      success: found?.success === true && found?.healthOk === true && artifactVerified,
    };
  });
  const gates = {
    health: hosts.every((h) => h.healthOk),
    version:
      summary.verify?.allMatch === true &&
      summary.verify.results.length === cfg.hosts.length &&
      cfg.hosts.every(
        (host) =>
          summary.verify!.results.filter((v) => v.server === host && v.match && v.actual === receipt.build)
            .length === 1
      ),
    nginx: cfg.hosts.every((host) => summary.hosts.find((h) => h.host === host)?.nginxOk === true),
    cdn: operation === 'verify' ? null : !cfg.cdn || summary.purge?.ok === true,
  };
  const success =
    summary.success &&
    hosts.every((h) => h.success) &&
    gates.health &&
    gates.version &&
    gates.nginx &&
    gates.cdn !== false;
  if (summary.success && !success)
    throw new Error('Cannot publish a successful result without complete gates');
  const result = {
    schemaVersion: 1,
    kind: 'zincapp-webdeploy-result',
    attemptId,
    operation,
    sourceCommit: receipt.sourceCommit,
    build: receipt.build,
    artifactSha256: receipt.artifact.artifactSha256,
    publicationReceiptSha256: publication.publicationReceiptSha256,
    startedAt,
    completedAt: new Date().toISOString(),
    success,
    hosts,
    gates,
  };
  const directory = resultDirectory(publication);
  const path = join(directory, `${attemptId}.json`),
    temporary = path + '.tmp',
    bytes = JSON.stringify(result, null, 2) + '\n';
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    linkSync(temporary, path);
    rmSync(join(directory, `.${attemptId}.pending`), { force: true });
    const directoryFd = openSync(directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return { path, sha256: sha256(bytes) };
}

export function validateAttemptId(value: string): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
    throw new Error('Invalid attempt UUID');
}
function resultDirectory(publication: ValidatedPublication): string {
  let directory = publication.rootDir;
  for (const part of ['.release-artifacts', 'webdeploy-results']) {
    directory = join(directory, part);
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new Error('Unsafe result receipt directory');
    chmodSync(directory, 0o700);
  }
  return directory;
}
export function beginDeploymentAttempt(
  publication: ValidatedPublication,
  attemptId: string = randomUUID()
): string {
  validateAttemptId(attemptId);
  const directory = resultDirectory(publication);
  try {
    lstatSync(join(directory, `${attemptId}.json`));
    throw new Error('Attempt result already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(join(directory, `.${attemptId}.pending`), '', { flag: 'wx', mode: 0o600 });
  return attemptId;
}
