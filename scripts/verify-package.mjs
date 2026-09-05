import process from 'node:process';
import console from 'node:console';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const [tarball, version] = process.argv.slice(2);
if (!tarball || !version) throw new Error('Usage: verify-package.mjs <tgz> <version>');

const scratch = mkdtempSync(join(tmpdir(), 'webdeploy-package-'));
try {
  execFileSync('npm', [
    'install', '--prefix', scratch, '--ignore-scripts', '--no-audit', '--no-fund', resolve(tarball),
  ], { stdio: 'pipe' });
  const root = join(scratch, 'node_modules/@zincapp/znvault-plugin-webdeploy');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@zincapp/znvault-plugin-webdeploy' || pkg.version !== version) {
    throw new Error('Package identity mismatch');
  }
  for (const entry of Object.values(pkg.exports)) {
    for (const target of Object.values(entry)) readFileSync(join(root, target));
  }
  execFileSync(process.execPath, ['--input-type=module', '-e',
    "import plugin from '@zincapp/znvault-plugin-webdeploy'; import * as cli from '@zincapp/znvault-plugin-webdeploy/cli'; if (!plugin || !Object.keys(cli).length) throw Error('Missing exports');",
  ], { cwd: scratch, stdio: 'pipe' });
  console.log(`ESM exports and declarations verified: ${version}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
