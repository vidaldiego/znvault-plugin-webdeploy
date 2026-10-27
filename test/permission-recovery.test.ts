import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sharedPermissionsScript, withRemotePermissions } from '../src/cli/transfer.js';
import { sshBaseArgs, withSshSession } from '../src/cli/ssh-exec.js';
import type { HostConnection } from '../src/cli/types.js';
const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'permission-recovery-')));roots.push(root);
  const bin=join(root,'bin'),web=join(root,'web'),log=join(root,'calls');mkdirSync(bin);mkdirSync(web);
  writeFileSync(join(bin,'sudo'),'#!/bin/bash\nif [[ "$1" == "-n" ]]; then shift; fi\nexec "$@"\n',{mode:0o755});
  writeFileSync(join(bin,'chown'),'#!/bin/bash\nprintf "%s\\n" "chown $*" >> "$CALLS"\n',{mode:0o755});
  writeFileSync(join(bin,'chmod'),'#!/bin/bash\nprintf "%s\\n" "chmod $*" >> "$CALLS"\nexec /bin/chmod "$@"\n',{mode:0o755});
  writeFileSync(join(bin,'ssh'),'#!/bin/bash\nexec bash -c "${!#}"\n',{mode:0o755});
  vi.stubEnv('PATH',`${bin}:${process.env.PATH}`);vi.stubEnv('CALLS',log);
  return {root,web,log};
}
const conn:HostConnection={host:'fixture',port:22,user:'ops',keyPath:'/fixture/key',certPath:'/fixture/cert'};
it('restores permissions in the established remote transaction after authorization expires without a new SSH call',async()=>{
  const f=fixture();let expiredCalls=0;
  await expect(withSshSession([conn],async([scoped])=>withRemotePermissions({
    exec:async(c,cmd)=>{try{sshBaseArgs(c);}catch(e){expiredCalls++;throw e;}return {code:0,stdout:execFileSync('bash',['-c',cmd],{encoding:'utf8'}),stderr:''};},rsync:async()=>{},log:()=>{},
  },scoped!,`${f.web}/`,async()=>{await new Promise(r=>setTimeout(r,1100));throw Error('transfer interrupted');}),{maxDurationMs:1000,close:()=>{}})).rejects.toThrow('transfer interrupted');
  expect(expiredCalls).toBe(0);
  expect(readFileSync(f.log,'utf8')).toContain('www-data:www-data');
  expect(readFileSync(f.log,'utf8')).toContain('g-w');
});
it('restores the root and safe descendants even when a link appears during the open interval, without touching its target',()=>{
  const f=fixture();const nested=join(f.web,'nested'),outside=join(f.root,'outside');mkdirSync(nested);mkdirSync(outside);
  const safe=join(nested,'safe');writeFileSync(safe,'keep');chmodSync(outside,0o777);
  execFileSync('bash',['-c',sharedPermissionsScript(`${f.web}/`,'ops',false)]);
  symlinkSync(outside,join(nested,'link'));writeFileSync(f.log,'');
  expect(()=>execFileSync('bash',['-c',sharedPermissionsScript(`${f.web}/`,'ops',true)],{stdio:'pipe'})).toThrow();
  const calls=readFileSync(f.log,'utf8');
  expect(calls).toContain(`www-data:www-data ${f.web}`);
  expect(calls).toContain(safe);
  expect(calls).not.toContain(outside);
  expect(existsSync(join(nested,'link'))).toBe(true);
});
it('restores after permission opening fails without executing the transfer',async()=>{
  const f=fixture();const bin=join(f.root,'bin');
  writeFileSync(join(bin,'chmod'),'#!/bin/bash\nprintf "%s\\n" "chmod $*" >> "$CALLS"\nif [[ "$*" == *g+w* ]]; then exit 1; fi\nexec /bin/chmod "$@"\n',{mode:0o755});
  let transferred=false;
  await expect(withRemotePermissions({exec:async()=>{throw Error('must not open another command');},rsync:async()=>{},log:()=>{}},conn,`${f.web}/`,async()=>{transferred=true;})).rejects.toThrow(/opening failed/);
  expect(transferred).toBe(false);expect(readFileSync(f.log,'utf8')).toContain('g-w');
});
it('restores on remote termination using the existing EXIT trap',async()=>{
  const f=fixture();const pidFile=join(f.root,'ssh.pid');
  writeFileSync(join(f.root,'bin/ssh'),`#!/bin/bash\necho $$ > '${pidFile}'\nexec bash -c "\${!#}"\n`,{mode:0o755});
  await expect(withRemotePermissions({exec:async()=>{throw Error('must not reconnect');},rsync:async()=>{},log:()=>{}},conn,`${f.web}/`,async()=>{process.kill(Number(readFileSync(pidFile,'utf8').trim()),'SIGTERM');await new Promise(r=>setTimeout(r,100));})).rejects.toThrow(/interrupted/);
  expect(readFileSync(f.log,'utf8')).toContain('www-data:www-data');expect(readFileSync(f.log,'utf8')).toContain('g-w');
});
it('reports original transfer failure together with a restoration failure',async()=>{
  const f=fixture();
  writeFileSync(join(f.root,'bin/chown'),'#!/bin/bash\nprintf "%s\\n" "chown $*" >> "$CALLS"\nif [[ "$*" == *www-data:www-data* ]]; then exit 1; fi\n',{mode:0o755});
  await expect(withRemotePermissions({exec:async()=>{throw Error('must not reconnect');},rsync:async()=>{},log:()=>{}},conn,`${f.web}/`,async()=>{throw Error('original transfer failure');})).rejects.toThrow('original transfer failure; remote permission restoration failed');
  expect(readFileSync(f.log,'utf8')).toContain('g-w');
});
it('non-recursive cleanup restores root permissions without walking retained builds',async()=>{
  const f=fixture();mkdirSync(join(f.web,'123'));writeFileSync(join(f.web,'123','retained'),'keep');
  await withRemotePermissions({exec:async()=>{throw Error('must not reconnect');},rsync:async()=>{},log:()=>{}},conn,`${f.web}/`,{recursive:false},async()=>{});
  const calls=readFileSync(f.log,'utf8');expect(calls).toContain(`www-data:www-data ${f.web}/`);expect(calls).not.toContain('/123');
});
