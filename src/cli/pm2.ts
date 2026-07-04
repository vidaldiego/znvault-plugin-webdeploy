// Path: src/cli/pm2.ts
import type { Exec, HostConnection } from './types.js';
import { execOrThrow } from './ssh-exec.js';

const PM2_SETTLE_MS = 2000;

export async function reloadOrStartPm2(
  exec: Exec, conn: HostConnection,
  opts: { remotePath: string; app: string; log(l: string): void; settleMs?: number }
): Promise<void> {
  const jlist = await exec(conn, 'pm2 jlist');
  let exists = false;
  try {
    const apps = JSON.parse(jlist.stdout) as { name: string }[];
    exists = apps.some(a => a.name === opts.app);
  } catch { exists = false; }

  const verb = exists ? 'reload' : 'start';
  opts.log(`[${conn.host}] PM2 ${verb} (${exists ? 'zero-downtime reload' : 'first start'})...`);
  await execOrThrow(exec, conn, `cd ${opts.remotePath} && pm2 ${verb} ecosystem.config.js --env production`, `pm2 ${verb}`);

  const ceilingMs = opts.settleMs ?? PM2_SETTLE_MS;
  const intervalMs = 250;
  const deadline = Date.now() + ceilingMs;
  let online = false;
  // Poll at least once; then until online, guaranteeing one final probe at
  // or after the deadline. Capturing `pastDeadline` BEFORE each probe (rather
  // than checking only after a failed probe) ensures the loop always takes
  // one more sample once the deadline has passed, instead of breaking right
  // before it — otherwise an app that comes online in the window between the
  // last pre-deadline probe and the deadline itself would be missed, even
  // though it would have been caught by the old single end-of-ceiling probe.
  for (;;) {
    const pastDeadline = Date.now() >= deadline;
    const status = await execOrThrow(exec, conn, `pm2 describe ${opts.app}`, 'pm2 describe');
    if (status.includes('online')) { online = true; break; }
    if (pastDeadline) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  if (!online) throw new Error(`[${conn.host}] PM2 app '${opts.app}' is not running after ${verb}`);
  await execOrThrow(exec, conn, 'pm2 save', 'pm2 save');
}

export async function reloadNginx(exec: Exec, conn: HostConnection): Promise<void> {
  await execOrThrow(exec, conn, 'sudo nginx -s reload', 'nginx reload');
}
