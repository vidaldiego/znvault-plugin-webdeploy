import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { deployStatic, installAppDeps, cleanupOldBuilds } from '../src/cli/transfer.js';
import { permissionSessionScript, runPermissionProcess } from '../src/cli/ssh-exec.js';
import { syncHelp } from '../src/cli/notify.js';
import type { HostConnection, WebDeployConfig } from '../src/cli/types.js';
const dirs: string[] = [];
const temp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'webdeploy-test-'))); dirs.push(d); return d; };
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
const conn: HostConnection = { host: 'h', user: 'ops', port: 22, keyPath: '/key', certPath: '/cert' };

describe('scoped static permissions', () => {
  function fixture() {
    const root = temp();
    const web = join(root, 'web'); const bin = join(root, 'bin'); const log = join(root, 'calls');
    mkdirSync(bin); mkdirSync(web);
    for (const d of ['42/old', '30541/old', 'tinymce/plugins/nested']) mkdirSync(join(web, d), { recursive: true });
    writeFileSync(join(web, 'tinymce/plugins/nested/file.js'), 'old');
    writeFileSync(join(bin, 'chown'), '#!/bin/bash\nprintf "%s\\n" "chown $*" >> "$CALLS"\n', {mode:0o755});
    writeFileSync(join(bin, 'chmod'), '#!/bin/bash\nprintf "%s\\n" "chmod $*" >> "$CALLS"\n', {mode:0o755});
    writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nif [[ "$1" == chown || "$1" == chmod ]]; then printf "%s\\n" "$*" >> "$CALLS"; else exec "$@"; fi\n', { mode: 0o755 });
    const exec = async (_c: HostConnection, command: string) => {
      try { return { code: 0, stdout: execFileSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: log } }), stderr: '' }; }
      catch { return { code: 1, stdout: '', stderr: 'fixture rejected' }; }
    };
    const cfg: WebDeployConfig = { hosts: ['h'], ssh: { user: 'ops' }, versionFile: 'v', static: { localPath: 'public/', remotePath: `${web}/` } };
    const permissions = async (_c: HostConnection, open: string, restore: string, action: () => Promise<void>) => runPermissionProcess(spawn('bash', ['-c', permissionSessionScript(open,restore)], {env:{...process.env,PATH:`${bin}:${process.env.PATH}`,CALLS:log}}),'fixture',action);
    return { web, log, exec, cfg, bin, permissions };
  }
  it('opens and restores shared nested trees without recursively touching any retained numeric directory', async () => {
    const f = fixture();
    await expect(deployStatic({ permissions: f.permissions, exec: f.exec, rsync: async args => { if (args.includes('--delay-updates')) throw new Error('transfer failed'); }, log: () => {} }, conn, f.cfg, '30542')).rejects.toThrow('transfer failed');
    const calls = readFileSync(f.log, 'utf8').trim().split('\n');
    expect(calls.some(c => c.includes(`-R ops:www-data ${f.web}/tinymce`))).toBe(true);
    expect(calls.some(c => c.includes(`www-data:www-data ${f.web}/tinymce`))).toBe(true);
    expect(calls.some(c => /-R .*\/(42|30541)(\/|$)/.test(c))).toBe(false);
    expect(calls.some(c => c.endsWith(`-R ops:www-data ${f.web}/`))).toBe(false);
  });
  it('rejects shared symlinks before changing permissions on their target', async () => {
    const f = fixture(); const outside = temp();
    symlinkSync(outside, join(f.web, 'tinymce/plugins/link'));
    await expect(deployStatic({ permissions: f.permissions, exec: f.exec, rsync: async () => {}, log: () => {} }, conn, f.cfg, '30542')).rejects.toThrow();
  });
  it('fails closed before transfer when symlink enumeration cannot be read', async () => {
    const f = fixture(); let transfers = 0;
    writeFileSync(join(f.bin, 'find'), '#!/bin/bash\nexit 1\n', {mode:0o755});
    await expect(deployStatic({permissions:f.permissions,exec:f.exec,rsync:async()=>{transfers++;},log:()=>{}},conn,f.cfg,'30542')).rejects.toThrow();
    expect(transfers).toBe(0);
  });
  it('retention removes only exact numeric directories and preserves digit-prefixed shared content', async () => {
    const f = fixture(); mkdirSync(join(f.web, '30542')); mkdirSync(join(f.web, '12345-shared'));
    await cleanupOldBuilds({permissions:f.permissions,exec:f.exec,rsync:async()=>{},log:()=>{}},conn,{...f.cfg,static:{...f.cfg.static!,retentionCount:1}});
    const {existsSync}=await import('node:fs');
    expect(existsSync(join(f.web,'12345-shared'))).toBe(true);
    expect(existsSync(join(f.web,'30542'))).toBe(true);
    expect(existsSync(join(f.web,'42'))).toBe(false);
    expect(existsSync(join(f.web,'30541'))).toBe(false);
  });
  it('rejects a build path traversal before any command', async () => {
    let calls = 0;
    await expect(deployStatic({ exec: async () => { calls++; return { code: 0, stdout: '', stderr: '' }; }, rsync: async () => {}, log: () => {} }, conn, { hosts: ['h'], ssh: {user:'ops'}, versionFile:'v', static:{localPath:'public/',remotePath:'/var/www/'} }, '../outside')).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe('install probes', () => {
  it('probes manifests, install stamp and node_modules in one round trip and skips a proven install', async () => {
    const calls: string[] = []; const hash = 'a'.repeat(64);
    await installAppDeps({ exec: async (_c, command) => { calls.push(command); return {code:0, stdout:`${hash}\n${hash}\npresent\n`,stderr:''}; }, rsync:async()=>{},log:()=>{} }, conn, {hosts:['h'],ssh:{user:'ops'},versionFile:'v',app:{localPath:'deploy',remotePath:'app',pm2App:'www',yarnVersion:'4.9.1'}});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('node_modules');
    expect(calls[0]).toContain('.deploy-install-stamp');
  });
});

describe('help success digest', () => {
  it('skips unchanged successful content but retries changed content after HTTP failure', async () => {
    const dir = temp(); writeFileSync(join(dir,'one.md'),'first'); const cacheDir = temp();
    let requests = 0; let ok = true;
    const fetcher = (async () => { requests++; return new Response('', {status:ok?200:500}); }) as typeof fetch;
    const opts = {url:'https://help.example/sync',key:'private',contentDir:dir};
    await syncHelp(fetcher,opts,()=>{},cacheDir);
    await syncHelp(fetcher,opts,()=>{},cacheDir);
    expect(requests).toBe(1);
    writeFileSync(join(dir,'one.md'),'second'); ok=false;
    await syncHelp(fetcher,opts,()=>{},cacheDir); ok=true;
    await syncHelp(fetcher,opts,()=>{},cacheDir);
    await syncHelp(fetcher,opts,()=>{},cacheDir);
    expect(requests).toBe(3);
  });
});

it('rejects a local static source symlink before it can be transferred',async()=>{
  const {validateStaticSource}=await import('../src/cli/transfer.js');
  const source=temp();const target=temp();mkdirSync(join(source,'30542'));mkdirSync(join(source,'nested'));symlinkSync(target,join(source,'nested','link'));
  expect(()=>validateStaticSource(source,'30542')).toThrow(/symlink/);
});
it('read-only health queries an existing PM2 RPC socket without executing the daemon-starting CLI',async()=>{
  const {buildHealthScript,parseHealthOutput}=await import('../src/cli/health.js');
  const root=temp();mkdirSync(join(root,'bin'));mkdirSync(join(root,'modules/pm2-axon'),{recursive:true});mkdirSync(join(root,'modules/pm2-axon-rpc'),{recursive:true});
  const marker=join(root,'daemon-started');
  writeFileSync(join(root,'bin/pm2'),`#!/bin/bash\ntouch '${marker}'\nprintf '[]'\n`,{mode:0o755});
  writeFileSync(join(root,'modules/pm2-axon/index.js'),`const {EventEmitter}=require('events');exports.socket=()=>{const s=new EventEmitter();s.connect=()=>setImmediate(()=>s.emit('connect'));s.close=()=>{};return s;};`);
  writeFileSync(join(root,'modules/pm2-axon-rpc/index.js'),`exports.Client=class {call(method,args,cb){if(method!=='getMonitorData')throw Error('mutation');cb(null,[{name:'www',pm2_env:{status:'online',secret:'must-not-leak'}}]);}};`);
  const specs=[{type:'pm2' as const,app:'www',requireAll:true}];
  const stdout=execFileSync('bash',['-c',buildHealthScript(specs,{readOnly:true})],{encoding:'utf8',env:{...process.env,PATH:`${root}/bin:${process.env.PATH}`}});
  expect(parseHealthOutput(specs,stdout).success).toBe(true);
  expect(stdout).not.toContain('secret');
  const {existsSync}=await import('node:fs');expect(existsSync(marker)).toBe(false);
});
it('help reports a non-blocking failed phase without stamping success',async()=>{
  const dir=temp();writeFileSync(join(dir,'one.md'),'content');
  const result=await syncHelp((async()=>new Response('',{status:500})) as typeof fetch,{url:'https://example/sync',key:'private',contentDir:dir},()=>{},temp());
  expect(result).toEqual({success:false});
});
