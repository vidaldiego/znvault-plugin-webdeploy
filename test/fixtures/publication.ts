import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function publicationFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'publication-')));
  for (const dir of ['deploy', 'public/30542', 'shared', 'ops/nginx', '.release-artifacts'])
    mkdirSync(join(root, dir), { recursive: true });
  const cfg = {
    hosts: ['host1', 'host2'],
    ssh: { user: 'ops' },
    versionFile: 'shared/version',
    app: {
      localPath: 'deploy',
      remotePath: 'app',
      pm2App: 'www',
      exclude: ['node_modules', '.yarn', 'out.log'],
    },
    static: { localPath: 'public/', remotePath: join(root, 'remote-static') + '/' },
    nginx: {
      config: {
        localPath: 'ops/nginx/default.conf',
        remotePath: '/etc/nginx/sites-available/default',
        enabledPath: '/etc/nginx/sites-enabled/default',
        upstream: 'www',
      },
    },
    healthChecks: [{ type: 'file', path: 'app/server.js' }],
    verify: { versionPath: '/version' },
    cdn: { provider: 'cloudflare', zoneId: 'Z', apiToken: 'alias:token', purge: 'everything' },
  };
  writeFileSync(join(root, 'webdeploy.config.json'), JSON.stringify(cfg));
  writeFileSync(join(root, 'ops/nginx/default.conf'), 'upstream www { server 127.0.0.1:3000; }');
  writeFileSync(join(root, 'deploy/server.js'), 'app bytes');
  writeFileSync(join(root, 'public/30542/main.js'), 'public bytes');
  writeFileSync(join(root, 'public/version'), '30542');
  writeFileSync(join(root, 'public/index.html'), 'new html');
  writeFileSync(join(root, 'shared/version'), '30542');
  writeFileSync(join(root, '.gitignore'), 'deploy/\npublic/\n.release-artifacts/\nremote-static/\napp/\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture'
  );
  const identity = (path: string, actual = path) => {
    const bytes = readFileSync(join(root, actual));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  };
  const files = [
    identity('app/server.js', 'deploy/server.js'),
    identity('static/30542/main.js', 'public/30542/main.js'),
    identity('static/version', 'public/version'),
    identity('static/index.html', 'public/index.html'),
    identity('release/shared-version', 'shared/version'),
  ].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const subject = { schemaVersion: 1, kind: 'zincapp-webdeploy-artifact', build: '30542', files };
  const receipt = {
    schemaVersion: 1,
    kind: 'zincapp-webdeploy-publication',
    sourceCommit: git('rev-parse', 'HEAD'),
    build: '30542',
    artifact: {
      ...subject,
      artifactSha256: hash(JSON.stringify(subject) + '\n'),
      fileCount: files.length,
      totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    },
    configuration: [identity('webdeploy.config.json'), identity('ops/nginx/default.conf')],
    validation: {
      validatedAt: new Date().toISOString(),
      mode: 'full',
      policyHash: 'a'.repeat(64),
      tests: [],
      inputHash: 'b'.repeat(64),
      toolchainHash: 'c'.repeat(64),
    },
  };
  const receiptPath = join(root, '.release-artifacts/publication.json');
  const save = () => writeFileSync(receiptPath, JSON.stringify(receipt));
  save();
  return {
    root,
    rootDir: root,
    cfg,
    receipt,
    receiptPath,
    configFile: join(root, 'webdeploy.config.json'),
    save,
    git,
  };
}
