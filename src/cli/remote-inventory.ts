import type { ExecPipe, HostConnection } from './types.js';
import { appExclusions, type ValidatedPublication } from './publication.js';

// Python only reads filesystem state; the potentially large manifest is stdin.
const PROGRAM = `import sys,json,os,stat,hashlib
try:
 data=json.load(sys.stdin)
 expected={f['path']:f for f in data['files'] if f['path'].split('/')[0] in data['roots']}
 seen=set()
 def excluded(rel):
  return any((rel==r['path'] or rel.startswith(r['path']+'/')) if r['rootOnly'] else r['path'] in rel.split('/') for r in data['excludes'])
 def rootpath(value):
  absolute=os.path.abspath(value)
  current=os.path.sep
  for part in absolute.split(os.path.sep):
   if not part: continue
   current=os.path.join(current,part)
   if stat.S_ISLNK(os.lstat(current).st_mode): raise ValueError('symlink')
  if not os.path.isdir(absolute): raise ValueError('root')
  return absolute
 def walk(path,logical,rel,kind):
  info=os.lstat(path)
  if stat.S_ISLNK(info.st_mode): raise ValueError('symlink')
  if kind=='app' and rel and excluded(rel): return
  if kind=='static' and '/' not in rel and rel.isascii() and rel.isdigit() and rel!=data['build'] and stat.S_ISDIR(info.st_mode): return
  if stat.S_ISDIR(info.st_mode):
   for entry in os.scandir(path): walk(entry.path,logical+'/'+entry.name,rel+'/'+entry.name if rel else entry.name,kind)
  elif stat.S_ISREG(info.st_mode):
   entry=expected.get(logical)
   if not entry or entry['bytes']!=info.st_size: raise ValueError('inventory')
   flags=os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)
   fd=os.open(path,flags)
   with os.fdopen(fd,'rb') as stream:
    before=os.fstat(stream.fileno()); digest=hashlib.sha256()
    if before.st_ino!=info.st_ino or before.st_dev!=info.st_dev: raise ValueError('changed')
    for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
    after=os.fstat(stream.fileno())
    if before.st_mtime_ns!=after.st_mtime_ns or before.st_size!=after.st_size: raise ValueError('changed')
   if digest.hexdigest()!=entry['sha256']: raise ValueError('digest')
   seen.add(logical)
  else: raise ValueError('special file')
 for kind,value in data['roots'].items(): walk(rootpath(value),kind,'',kind)
 if seen!=set(expected): raise ValueError('missing')
 print(json.dumps({'artifactSha256':data['artifactSha256'],'verified':True}))
except Exception:
 print('managed inventory verification failed',file=sys.stderr)
 sys.exit(1)
`;
export interface RemoteInventoryOptions {
  scope?: 'app' | 'all';
  staticRoot?: string;
}

export async function verifyRemoteInventory(
  pipe: ExecPipe,
  conn: HostConnection,
  publication: ValidatedPublication,
  options: RemoteInventoryOptions = {}
): Promise<void> {
  const { cfg, receipt } = publication;
  const payload = {
    files: receipt.artifact.files,
    build: receipt.build,
    artifactSha256: receipt.artifact.artifactSha256,
    roots:
      options.scope === 'app'
        ? { app: cfg.app!.remotePath }
        : { app: cfg.app!.remotePath, static: options.staticRoot ?? cfg.static!.remotePath },
    excludes: appExclusions(cfg),
  };
  const quoted = `'${PROGRAM.replace(/'/g, `'"'"'`)}'`;
  const result = await pipe(conn, `python3 -c ${quoted}`, JSON.stringify(payload));
  if (result.code !== 0) throw new Error(`[${conn.host}] installed artifact inventory mismatch`);
  let parsed: { verified?: boolean; artifactSha256?: string };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Invalid remote inventory receipt');
  }
  if (parsed.verified !== true || parsed.artifactSha256 !== receipt.artifact.artifactSha256)
    throw new Error('Remote inventory identity mismatch');
}
