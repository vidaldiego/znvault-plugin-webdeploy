# @zincapp/znvault-plugin-webdeploy

Generic web-app deployment plugin for the `znvault` CLI. It deploys static
assets and/or a Node app to one or more hosts over **rsync + SSH**, using
short-lived **SSH-CA certificates** minted by ZnVault instead of long-lived
keys, and resolves every secret it needs (API tokens, `.env` values, rendered
files) from the vault at run time via `alias:` references — nothing sensitive
is ever stored in a config file on disk.

It is a CLI-only plugin (no agent-side component), a sibling of
`znvault-plugin-payara`, and is registered with `znvault` through the same
plugin-loader mechanism.

## What it does

A single `znvault webdeploy run <config>` invocation:

1. Loads a named deploy config and resolves all `alias:` secret references
   from ZnVault (in memory only).
2. Ensures a usable SSH certificate exists (signs a new short-TTL one via
   `POST /v1/ssh/sign` if the cached one is missing/expiring/missing the
   right principal).
3. For each host, in order, gated:
   - rsyncs the app directory (if `app` is configured),
   - renders `.env` and any extra `app.files` from resolved secrets and
     writes them to the remote host over SSH **stdin** (mode 0600),
   - runs `corepack use yarn@<version> && yarn install` (if `app.yarnVersion`
     is set), **skipped if the remote `package.json` + `yarn.lock` hash
     matches the previous stamp file AND `node_modules` exists** — fail-safe,
     any missing/corrupt stamp/hash forces a fresh install,
   - rsyncs static assets in two phases: a new versioned directory first
     (with scope-limited `chown`/`chmod -R` to the new dir only), then an
     atomic, `--delay-updates` switchover of shared/HTML files (with
     scope-limited `chown`/`chmod` non-recursive to the webroot itself only),
   - reloads (or first-starts) the app under PM2 with a zero-downtime
     `pm2 reload`, **polls `pm2 describe` every 250ms up to a 2-second
     ceiling** instead of a fixed sleep,
   - reloads nginx,
   - runs the configured health checks **via one remote shell script** that
     emits `idx|STATUS|detail` lines (one per check), parsed locally into
     the same result strings as before — if they fail on any host except the
     last, the remaining hosts are **skipped** (gated rolling deploy).
4. Once at least one host deployed successfully: purges the Cloudflare CDN
   cache, waits for propagation, then **polls `GET /version` every 250ms
   up to a 5-second ceiling** instead of a blind 3-second sleep, verifies
   the served version on every successfully deployed host.
5. Cleans up old versioned build directories (retention count), syncs help
   content, and posts a webhook summary.

Non-fatal problems (CDN purge failure, version-verify mismatch, health
warnings) are recorded as **warnings** in the run summary; they do not fail
the command. See [Exit codes](#exit-codes).

## Install / registration

This package is not yet published; register it from a local build.

```bash
cd znvault-plugin-webdeploy
npm install
npm run build
```

The `znvault` CLI reads its config from
**`~/Library/Preferences/znvault-nodejs/config.json`** on macOS (not
`~/.znvault/config.json` — that directory holds unrelated files such as
`deploy-configs.json` and this plugin's own `webdeploy/configs.json` store).
Add (or create) a top-level `plugins` array and append a `path` entry
pointing at the built CLI entrypoint:

```json
{
  "plugins": [
    { "path": "/absolute/path/to/znvault-plugin-webdeploy/dist/cli.js" }
  ]
}
```

Back up the file first — it typically holds live profile credentials.
Verify with:

```bash
znvault webdeploy --help
znvault plugin list
```

Once the package is published to the registry, the equivalent entry is:

```json
{ "plugins": [{ "package": "@zincapp/znvault-plugin-webdeploy" }] }
```

Peer dependency: `@zincapp/znvault-cli >= 2.11.0` (optional at install time —
the host CLI provides `commander` and the plugin context at runtime).

## Requirements

- Node >= 18.
- System **OpenSSH** (`ssh`) on PATH.
- **GNU rsync >= 3.1.0** on PATH. macOS ships `openrsync` under the `rsync`
  name, which this plugin explicitly rejects (checked by `znvault webdeploy
  check` and before every `run`). Install a real rsync:
  ```bash
  brew install rsync
  ```
- The resolved SSH private key and its certificate must live at paths with
  **no whitespace** — rsync's `-e` transport string is whitespace-split with
  no quoting support, so a spaced path would silently corrupt the SSH
  command line. The plugin fails fast with a clear error if either path
  contains whitespace.

## Configuration

Deploy configs are named and stored locally at
`~/.znvault/webdeploy/configs.json`, written with **mode 0600**. Manage them
with the `config` subcommands (below) — there is no need to hand-edit the
store file directly.

### Schema

```jsonc
{
  // Required. Hosts are deployed to in array order (gated: a host is
  // skipped once an earlier host fails or fails its health gate, except
  // health failures on the LAST host, which are recorded but don't gate).
  "hosts": ["10.0.0.1", "10.0.0.2"],

  // Required.
  "ssh": {
    "user": "sysadmin",
    "port": 22,               // optional, default 22
    "principal": "deploy",    // optional, default "deploy"
    "ttlSeconds": 3600        // optional, default 3600 (1h)
  },

  // Required. Local file whose trimmed content is the build/version number
  // used for the versioned static directory and post-deploy verification
  // (e.g. a "shared/version" file written by your build).
  "versionFile": "shared/version",

  // Optional — Node app deployment. Omit if this host only serves static assets.
  "app": {
    "localPath": "deploy",          // local staged dir to rsync (staging it is the caller's job)
    "remotePath": "zincapp-ts",     // remote path, relative to the SSH user's home
    "pm2App": "www",                // PM2 app name (ecosystem.config.js entry)
    "exclude": ["*.log"],           // optional rsync --exclude patterns
    // Rendered to <remotePath>/.env. Values are `alias:` refs or plain
    // non-secret literals (e.g. NODE_ENV=production). Keys that LOOK secret
    // (KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL, case-insensitive) MUST
    // be alias: refs — config-validate rejects a literal there.
    "env": {
      "API_KEY": "alias:webapp/prod/remote-api.key",
      "NODE_ENV": "production"
    },
    // Extra rendered files: remote-relative path -> alias: ref for the
    // WHOLE file content. Every value here must be an alias: ref (no
    // exceptions — file contents are always secret-designated).
    "files": {
      ".yarnrc.yml": "alias:webapp/prod/yarnrc.content"
    },
    "yarnVersion": "4.9.1"   // corepack pin; omit to skip corepack/yarn install entirely
  },

  // Optional — static asset deployment. Omit if this is an app-only host.
  // localPath/remotePath MUST end with '/' (validated).
  "static": {
    "localPath": "public/",
    "remotePath": "/var/www/",
    "retentionCount": 50     // optional, default 50 — old versioned dirs kept
  },

  "nginx": { "reload": true },  // optional; defaults to true whenever `static` is present

  // Optional health checks, run after each host deploys (and used
  // standalone by `check`). Any of 7 spec types, any number, any mix:
  "healthChecks": [
    { "type": "systemd", "unit": "myapp.service" },
    { "type": "http", "url": "http://localhost:3000/health", "expectStatus": 200 },
    { "type": "pm2", "app": "www" },
    { "type": "ports", "ports": [3000, 3001] },
    { "type": "file", "path": "/var/www/current/index.html" },
    { "type": "disk", "warnAt": 80, "failAt": 90 },
    { "type": "memory", "warnAt": 80, "failAt": 90 }
  ],

  // Optional Cloudflare cache purge, run once after the last successful host.
  "cdn": {
    "provider": "cloudflare",
    "zoneId": "alias:webapp/prod/cloudflare.zoneId",   // alias: ref or plain
    "apiToken": "alias:webapp/prod/cloudflare.token",  // alias: ref ONLY
    "purge": "everything"   // or an array of specific URLs
  },

  // Optional post-deploy version verification (also powers `status`).
  "verify": {
    "versionPath": "/version",
    "hostHeader": "app.example.com"   // optional Host header override
  },

  // Optional post-deploy notifications. Both are best-effort / non-blocking.
  "notify": {
    "webhook": "alias:webapp/prod/slack.webhook",   // alias: ref ONLY
    "helpSync": {
      "url": "https://chatbot.example.com/help-sync",
      "key": "alias:webapp/prod/help-sync.key",     // alias: ref ONLY
      "contentDir": "help-content"                  // local dir of *.md files
    }
  }
}
```

### Secret-designated fields (alias-only)

The following fields are **rejected by `config-validate`** if given as a
plain literal — they must be `alias:` references:

- `cdn.apiToken`
- `app.env.<key>` for any key matching `/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i` (case-insensitive) — plain values are still allowed for non-secret-looking keys, plus an explicit allowlist (`production`, `development`, `staging`, `test`, `true`, `false`)
- `app.files.<path>` — every file value, no exceptions (whole-file content is always secret-designated)
- `notify.webhook`
- `notify.helpSync.key`

`cdn.zoneId` may be either an `alias:` reference or a plain value (it is not
generally secret, just tenant-specific).

## Secret-reference convention

Two forms are accepted anywhere a config value is described as taking a
"secret ref":

- **`alias:<path>.<field>`** — resolves via the vault: `GET
  /v1/secrets/alias/{alias}` to find the secret's ID, then `POST
  /v1/secrets/{id}/decrypt` to fetch its data. The alias/field split happens
  on the **last dot of the last path segment** (matching the
  `znvault-plugin-payara` convention), so `alias:webapp/prod/cloudflare.token`
  resolves alias `webapp/prod/cloudflare`, field `token`. A ref with no dot
  in its last segment (`alias:webapp/prod/webhook`) uses the secret's
  `data.value` (or, for binary/file-style secrets, base64-decodes
  `data.content`).
- **`literal:<value>` or a plain string** — the `literal:` prefix (if present) is
  stripped and the remainder used; a plain string (not prefixed) is also used
  as-is. For example, `literal:production` → `production`, or `production` →
  `production`. (Any string not starting with `alias:` is treated as plain.)

Resolution happens **once, in memory, at the start of a run** — a resolved
config is never persisted to disk. Every resolved secret value is registered
in a `Redactor` for the duration of the run; the redactor masks all
registered values (longest match first, so a value that's a substring of
another can't leak the longer one) in every line the plugin logs, in
`--json` summaries, and in dry-run plan output. Secret values are designed
to never reach stdout, stderr, argv, or disk on the machine running
`znvault`.

## SSH-CA requirements

This plugin authenticates over **SSH certificates**, not static keys. It
expects your ZnVault tenant's SSH CA to already be configured — see the full
guide: [`../docs/SSH_CA_GUIDE.md`](../docs/SSH_CA_GUIDE.md).

Minimally, before running a deploy you need:

1. **Principal mapping** — your SSO group (or the caller's identity) maps to
   a principal, by default `"deploy"` (overridable per-config via
   `ssh.principal`).
2. **A server group / access rule** granting that principal SSH access to
   the target Linux user (`ssh.user` in the config) on the deploy hosts.
3. **Each target host trusts the CA**: `TrustedUserCAKeys` in `sshd_config`
   points at the tenant's CA public key, and `AuthorizedPrincipalsFile` maps
   the target user to the principals allowed to log in as it.

At run time the plugin:

- Looks for an SSH key at `~/.ssh/id_ed25519` (falling back to `id_ecdsa`,
  then `id_rsa`).
- Checks for a cached certificate at `<key>-webdeploy-cert.pub` — a
  **dedicated path** distinct from the interactive `<key>-cert.pub` used by
  `znvault ssh connect`, so this plugin never clobbers (or is clobbered by)
  your interactive certificate.
- Re-signs via `POST /v1/ssh/sign` whenever the cached cert is missing,
  unparsable, missing the configured principal, or expiring within 5
  minutes — using `ssh.ttlSeconds` (default 3600s / 1h) and the configured
  principal.
- Uses the resulting `-i <key> -o CertificateFile=<cert>` pair for every
  `ssh`/`rsync -e` invocation for the run.

## Commands

```
znvault webdeploy run <config>       Run a gated rolling deploy
znvault webdeploy check <config>     Preflight: vault auth, secrets, cert, host reachability, health
znvault webdeploy status <config>    Show the served version on each host
znvault webdeploy config list                    List stored config names
znvault webdeploy config show <name>             Print a stored config (JSON)
znvault webdeploy config validate <name>         Validate a stored config
znvault webdeploy config import <name> <file>    Import + validate a config from a JSON file
```

### `run`

```
znvault webdeploy run <config> [--json] [--dry-run] [--skip-purge]
```

- `--dry-run` — resolves secrets, signs/validates the SSH cert, and prints
  the deploy plan (hosts, app remote path/PM2 app, static config, CDN purge
  mode) without touching any host. All secret values are redacted from the
  printed plan.
- `--json` — prints the machine-readable `RunSummary` instead of the
  human-readable summary lines.
- `--skip-purge` — drops the `cdn` section for this run (no Cloudflare
  purge).

A run acquires a **per-config lock** (see [Locking](#locking)) before
touching any host, so two overlapping `run`s against the same config name
cannot race each other.

### `check`

Proves, without deploying: rsync version is acceptable, the config is valid
and every configured secret resolves, an SSH certificate is available (or
gets signed), every host is SSH-reachable, and every configured health check
passes. Exits non-zero if any of those fail.

### `status`

Fetches `verify.versionPath` from every host (with an optional `Host`
header override) and prints the served version, or the HTTP status/error if
the fetch fails. Requires `verify` to be configured; otherwise prints a
warning and does nothing.

Version probes use a raw `node:http` request so the `hostHeader` override
genuinely reaches the server (Node's `fetch` would strip it in favor of the
URL's hostname, making vhost-routed version checks impossible).

## Exit codes

**Exit code is non-zero if, and only if, at least one host's deploy
failed or was skipped** (`RunSummary.success === false`, i.e. not every
entry in `hosts[]` succeeded).

Everything else that can go wrong during a run — CDN purge failure, version
verification mismatch, a health check warning on a host that still deployed
— is recorded in `RunSummary.warnings` / per-host `healthResults` and
printed in the summary, but does **not** affect the exit code. `check`
follows the same idea at preflight time: it fails (exit 1) only when rsync
version, secret resolution/cert signing, SSH reachability, or a health check
itself fails — not on soft warnings within a check.

## Locking

`run` takes an exclusive, per-config-name lock file at
`<tmpdir>/znvault-webdeploy-<config>.lock` (created with `O_CREAT|O_EXCL`,
so two concurrent runs can't both "win"). The lock file records
`{pid, user, since, host}`. If a lock already exists:

- If the recorded PID is still alive (`process.kill(pid, 0)` doesn't throw,
  or throws `EPERM` because it belongs to another user), the lock is
  **held** and the new run fails immediately with `LockHeldError` — it is
  never stolen from a live process, even one owned by a different user.
- Only an `ESRCH` probe result (process definitely doesn't exist) — or an
  unreadable/corrupt lock file — is treated as stale, in which case the
  stale lock is removed and a fresh one acquired.

The lock is released on normal completion and on `SIGINT`/`SIGTERM`
(`process.exit(130)`/`143` respectively after cleanup).

## Performance improvements (v0.2.0)

The plugin includes four non-breaking performance optimizations:

- **QW3 (scoped permissions):** `chown`/`chmod` operations during static asset
  deployment are now scoped to written paths only. Phase A (versioned build
  directory) runs with `-R` recursively on the new dir; Phase B (webroot
  shared files) runs without `-R`, touching only the top-level directory
  itself. This avoids expensive recursive permission changes over dozens of
  pre-existing build directories. Safe because rsync runs as an unprivileged
  SSH user with `--delay-updates` (directory write suffices).

- **QW4 (install gate):** Dependency installation now skips `corepack use`
  and `yarn install` entirely when the remote manifest hash
  (sha256 of `package.json` + `yarn.lock`) matches the stamp file
  `<remotePath>/.deploy-install-stamp` AND `node_modules` exists on the
  remote. Any doubt (missing/corrupt stamp or `node_modules`) forces a fresh
  install — fail-safe.

- **QW5 (poll instead of sleep):** PM2 settle and version verification no
  longer use fixed-duration sleeps. `reloadOrStartPm2` polls `pm2 describe`
  every 250ms up to a 2-second ceiling; version verification polls `GET
  /version` every 250ms up to a 5-second ceiling, terminating early on
  success. Result strings and exit semantics are byte-identical to before.

- **QW6 (batched health):** Health checks now run as a single remote shell
  script (one per check, emitting `idx|STATUS|detail` lines) instead of
  ~10 separate SSH calls per host. The output is parsed locally and rendered
  into the same result strings as before. Result semantics and warnings are
  identical.

**None of these changes alter the security model** (SSH-CA certs, vault
secrets, redaction, stdin-piped file writes) **or the result contract**
(warnings vs. failures, exit codes, third-party integrations).

## Security model

- **No secrets at rest in configs.** Stored configs (`~/.znvault/webdeploy/configs.json`,
  mode 0600) only ever contain `alias:` references or non-secret plain
  values — `config-validate` enforces this on import/`config validate`.
- **In-memory resolution only.** Secrets are fetched from the vault once,
  at the start of `run`/`check`, and only live in process memory for that
  invocation.
- **Universal redaction.** Every resolved secret value is registered in a
  `Redactor` and masked out of all logged output, `--json` summaries, and
  dry-run plans for the run.
- **Remote file writes never touch argv.** `.env` and `app.files` content
  is piped to the remote host over SSH **stdin** (`writeRemoteFileIfChanged`
  uses `umask 077 && cat > tmp && chmod 600 tmp && mv tmp <path>`), so
  rendered secret content never appears in a remote process list or shell
  history, and files land with mode 0600.
- **Idempotent writes.** Before writing, the remote file's current
  `sha256sum` is compared to the local content's hash; unchanged files are
  left untouched (no needless remote writes or PM2/nginx churn).
- **Short-lived SSH credentials.** Certificates are signed for
  `ssh.ttlSeconds` (default 1 hour) and re-signed automatically once they're
  within 5 minutes of expiry — no long-lived key material is deployed to or
  trusted by target hosts beyond the CA's own trust anchor.

## Local development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build        # tsc
```

All business logic (SSH/rsync execution, PM2, health checks, CDN purge,
notifications, locking) is dependency-injected, so the full suite runs
without any real SSH connection, host, or vault instance.
