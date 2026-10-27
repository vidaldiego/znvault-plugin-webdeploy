import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { registerAllCommands } from '../src/cli/commands/index.js';
import type { CLIPluginContext } from '../src/cli/plugin-types.js';
import type { WebDeployConfig, HostConnection } from '../src/cli/types.js';
import { digest } from '../src/cli/nginx.js';
const content='upstream www { server 127.0.0.1:3000; }';
const cfg:WebDeployConfig={hosts:['h1','h2'],ssh:{user:'ops'},versionFile:'v',static:{localPath:'public/',remotePath:'/var/www/'},nginx:{config:{localPath:'nginx',remotePath:'/etc/nginx/sites-available/web',enabledPath:'/etc/nginx/sites-enabled/web',upstream:'www'}},verify:{versionPath:'/version'},healthChecks:[{type:'file',path:'/ready'}],notify:{helpSync:{url:'https://example/sync',key:'alias:secret',contentDir:'help'}}};
const conns:HostConnection[]=cfg.hosts.map(host=>({host,user:'ops',port:22,keyPath:'/key',certPath:'/cert'}));
it('registers verify with a required exact expected build', () => {
  const command=new Command(); registerAllCommands(command,{} as CLIPluginContext);
  const verify=command.commands.find(c=>c.name()==='verify');
  expect(verify).toBeDefined();
  expect(verify!.options.find(o=>o.long==='--expected-build')?.mandatory).toBe(true);
});
describe('read-only fleet verification',()=>{
  it('checks every host, exact config and version even after the first host fails; exposes no mutation capabilities',async()=>{
    const {verifyDeploy}=await import('../src/cli/verify.js');
    const commands:{host:string;command:string}[]=[]; const versions:string[]=[];
    const summary=await verifyDeploy('prod',cfg,conns,'30542',{
      exec:async(c,command)=>{ commands.push({host:c.host,command}); return {code:0,stdout:command.includes('sha256sum')?digest(content):command.includes('node -e')?'':c.host==='h1'?'0|FAIL|missing':'0|OK|exists',stderr:''}; },
      readNginxFile:()=>content,
      probeVersion:async(server)=>{versions.push(server); return {ok:true,status:200,body:'30542'};},
      versionVerifyCeilingMs:0,
    });
    expect(summary.success).toBe(false);
    expect(summary.hosts.map(h=>h.healthOk)).toEqual([false,true]);
    expect(versions.sort()).toEqual(['h1','h2']);
    expect(commands.some(c=>/rsync|chmod|chown|reload|mkdir|yarn|curl .*POST/.test(c.command))).toBe(false);
    expect(commands.filter(c=>c.command.includes('sha256sum')).map(c=>c.host)).toEqual(['h1','h2']);
  });
  it('fails on predecessor nginx bytes or missing verification configuration',async()=>{
    const {verifyDeploy}=await import('../src/cli/verify.js');
    const deps={exec:async()=>({code:0,stdout:'a'.repeat(64),stderr:''}),readNginxFile:()=>content,probeVersion:async()=>({ok:true,status:200,body:'30542'}),versionVerifyCeilingMs:0};
    const result=await verifyDeploy('prod',cfg,conns,'30542',deps);
    expect(result.success).toBe(false);
    await expect(verifyDeploy('prod',{...cfg,verify:undefined},conns,'30542',deps)).rejects.toThrow(/verify/);
  });
});
it('verifies a fully matching fleet and fails on a single exact-version mismatch',async()=>{
  const {verifyDeploy}=await import('../src/cli/verify.js');
  let mismatch=false;
  const deps={exec:async(_c:HostConnection,cmd:string)=>({code:0,stdout:cmd.includes('sha256sum')?digest(content):cmd.includes('node -e')?'':'0|OK|exists',stderr:''}),readNginxFile:()=>content,probeVersion:async(host:string)=>({ok:true,status:200,body:mismatch&&host==='h2'?'30541':'30542'}),versionVerifyCeilingMs:0};
  expect((await verifyDeploy('prod',cfg,conns,'30542',deps)).success).toBe(true);
  mismatch=true; expect((await verifyDeploy('prod',cfg,conns,'30542',deps)).success).toBe(false);
});
it('does not invoke nginx syntax commands that can open/create configured log files',async()=>{
  const {verifyDeploy}=await import('../src/cli/verify.js');const commands:string[]=[];
  await verifyDeploy('prod',cfg,conns,'30542',{exec:async(_c,cmd)=>{commands.push(cmd);return {code:0,stdout:cmd.includes('sha256sum')?digest(content):cmd.includes('node -e')?'':'0|OK|exists',stderr:''};},readNginxFile:()=>content,probeVersion:async()=>({ok:true,status:200,body:'30542'}),versionVerifyCeilingMs:0});
  expect(commands.some(c=>/nginx -[tT]/.test(c))).toBe(false);
});
