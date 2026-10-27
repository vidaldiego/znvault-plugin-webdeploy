# @zincapp/znvault-plugin-webdeploy

## 0.5.0: mandatory publication and deployment receipts

Both `run` and `verify` require `--config-file <path>` and `--receipt <path>`.
The named configuration still identifies the lock and summary; publication uses
the explicitly reviewed file. This is a breaking change for older direct calls.
The web release rail generates the publication receipt after exact-candidate
validation. It binds a clean source commit, build, complete staged file inventory,
configuration and validation fingerprints. A mutating run requires validation less
than 24 hours old; read-only verification may inspect older evidence. Future dates,
changed inputs, missing/extra files, hidden exclusions and symlinks are rejected.
These unsigned receipts prove integrity within a trusted workstation workflow;
they are not signatures or authenticated human approval.

Publication requires app, static, managed nginx, health and version configuration.
App exclusions must be exact runtime/dependency paths, not wildcard patterns.
The plugin checks Python availability and destination paths before transfer,
then verifies app hashes before dependency scripts can execute. Selected/shared
static bytes are transferred once to a private temporary directory outside the
webroot, hashed before local promotion, and checked again in the installed tree
before PM2 activation. Missing, extra, changed or symlinked managed files block
activation and later hosts. Old numeric builds and explicitly excluded runtime
files are not recursively hashed. Verification sends manifests over SSH stdin.

Each valid invocation reserves a unique UUID before secret resolution. The caller
may pass `--attempt-id <uuid>`; otherwise the CLI generates one. Results are written
atomically with private permissions and fsync under
`.release-artifacts/webdeploy-results/<uuid>.json`, including failed/partial attempts.
The JSON summary includes `deploymentReceipt:{path,sha256}`. A result binds source,
build, artifact and publication digest to every configured host and the health,
version, nginx and CDN gates. It contains no resolved secrets or raw error output.
A result-writing failure cannot produce successful completion. The web consumer
requires the current caller UUID and strict invocation times, so an earlier result
cannot satisfy a later attempt. `--skip-purge` is rejected.

`verify` hashes installed bytes and checks the remote gates without mutating hosts;
its result is persisted locally. A deploy result does not prove completion of the
web rail's later print, SIF or release-tag steps. Publication/installation of this
plugin and a production rollout remain distinct operations.

## 0.3.0: reviewed nginx ownership

`run <name> --config-file <path>` consumes a reviewed repository configuration
without updating the named config store; relative paths resolve from the working
directory. The name still identifies the lock and summary.

Optional `nginx.config` accepts `localPath`, `remotePath` (one sites-available
file), `enabledPath` (the enabled site), `upstream` and optional `previousSha256`.
Without a predecessor hash it verifies exact bytes only. An explicit reviewed
predecessor permits replacement; all other drift is fatal. Before any transfer,
all hosts must pass hash, enabled-site, effective include and syntax checks.
After app reload, all configured upstreams must accept TCP connections. Managed
upstreams deliberately support only explicit IPv4 loopback servers, least_conn
and keepalive; unsupported directives fail closed rather than being guessed.

Approved file changes use stdin, unique staging and backup files, double
readback, syntax check and graceful reload. Apply/reload/post-host-health failure
restores that site's predecessor unless concurrent edits make rollback unsafe.
Application rollback is separate, and incomplete rollouts retain old assets.
This is not a provisioning command: packages, site files, symlinks and host
permissions must already exist. Do not put private keys or secrets in this
versioned configuration.

Use `requireAll: true` on PM2 and ports health specs to make partial failures
blocking. Transport failures always fail health checks. TCP reachability and
PM2 online are not substitutes for an authenticated application/PDF acceptance.

In 0.3/0.4, configs without `nginx.config` retained a reload-only path; 0.5 publication
requires managed nginx evidence as described above. Publishing,
installation and each production rollout are separate authorization boundaries;
a package release is not evidence that a particular fleet was commissioned.

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

A single `znvault webdeploy run <config> --config-file webdeploy.config.json --receipt <receipt.json>` invocation:

1. Validates the receipt and explicit config before resolving `alias:` secret
   references from ZnVault (in memory only).
2. Ensures a usable SSH certificate exists (signs a new short-TTL one via
   `POST /v1/ssh/sign` if the cached one is missing/expiring/missing the
   right principal).
3. For each host, in order, gated:
   - verifies destination paths, rsyncs the app directory and hashes the installed
     app before executing dependency scripts,
   - renders `.env` and any extra `app.files` from resolved secrets and
     writes them to the remote host over SSH **stdin** (mode 0600),
   - runs `COREPACK_ENABLE_AUTO_PIN=0 COREPACK_DEFAULT_TO_LATEST=0 corepack yarn@<version> install --immutable` (if `app.yarnVersion`
     is set), **skipped if the remote `package.json` + `yarn.lock` hash
     matches the previous stamp file AND `node_modules` exists** — fail-safe,
     any missing/corrupt stamp/hash forces a fresh install, while any attempted
     lockfile rewrite fails the deploy,
   - transfers static assets once to private staging and verifies their hashes,
     then promotes them locally on the host: the selected versioned directory
     followed by shared/HTML files using `--delay-updates`, with existing scoped
     permission restoration; verifies the final installed inventory,
   - reloads (or first-starts) the app under PM2 with a zero-downtime
     `pm2 reload`, **polls `pm2 describe` every 250ms up to a 2-second
     ceiling** instead of a fixed sleep,
   - reloads nginx,
   - runs the configured health checks **via one remote shell script** that
     emits `idx|STATUS|detail` lines (one per check), parsed locally into
     the same result strings as before — if they fail, the command fails; when
     more hosts remain, they are **skipped** (gated rolling deploy).
4. Once at least one host deployed successfully: purges the Cloudflare CDN
   cache, waits for propagation, then **polls `GET /version` every 250ms
   up to a 5-second ceiling** instead of a blind 3-second sleep, verifies
   the served version on every successfully deployed host.
5. Only after every host, health check, CDN purge and version check succeeds,
   cleans up old versioned build directories (retention count). Help sync and
   webhook notification remain best effort.
6. Persists the identity-bound deployment result before reporting success.

If any blocking post-deploy gate fails after a host changed, the command exits
non-zero, marks the summary `recoveryRequired`, and retains old versioned assets
for recovery. See [Exit codes](#exit-codes).

## Install / registration

The package is published on npm. A local-path registration is still useful for
testing an unreleased build:

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

The registry-backed entry is:

```json
{ "plugins": [{ "package": "@zincapp/znvault-plugin-webdeploy" }] }
```

Peer dependency: `@zincapp/znvault-cli >= 2.11.0` (optional at install time —
the host CLI provides `commander` and the plugin context at runtime).

## Requirements

- Node >= 18.
- Remote Python >= 3.8 with `O_NOFOLLOW`, bash and rsync; private staging uses
  temporary disk space for one selected/shared static tree per active host.
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

Addresses, SSH users and alias paths below are placeholders: the addresses are
RFC 5737 documentation ranges (`192.0.2.0/24`), and the `alias:` paths are
illustrative. Substitute your own — the real values live in your vault and your
local config store, never in this repo.

```jsonc
{
  // Required. Hosts are deployed to in array order (gated: a host is
  // skipped once an earlier host fails or fails its health gate. A health
  // failure on the last host still makes the whole command fail).
  "hosts": ["192.0.2.1", "192.0.2.2"],

  // Required.
  "ssh": {
    "user": "ops",
    "port": 22,               // optional, default 22
    "principal": "deploy",    // optional, default "deploy"
    "ttlSeconds": 3600        // optional, default 3600 (1h)
  },

  // Required. Local file whose trimmed content is the build/version number
  // used for the versioned static directory and post-deploy verification
  // (e.g. a "shared/version" file written by your build).
  "versionFile": "shared/version",

  // Required for receipt-backed publication.
  "app": {
    "localPath": "deploy",          // local staged dir to rsync (staging it is the caller's job)
    "remotePath": "zincapp-ts",     // remote path, relative to the SSH user's home
    "pm2App": "www",                // PM2 app name (ecosystem.config.js entry)
    "exclude": ["node_modules", "out.log", "error.log"], // exact runtime paths
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

  // Required for receipt-backed publication.
  // localPath/remotePath MUST end with '/' (validated).
  "static": {
    "localPath": "public/",
    "remotePath": "/var/www/",
    "retentionCount": 50     // optional, default 50 — old versioned dirs kept
  },

  "nginx": {
    "config": {
      "localPath": "ops/nginx/default.conf",
      "remotePath": "/etc/nginx/sites-available/default",
      "enabledPath": "/etc/nginx/sites-enabled/default",
      "upstream": "www"
    }
  },

  // Required publication health checks, run after each host deploys (and used
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

  // Required publication version verification (also powers `status`).
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
znvault webdeploy run <config> --config-file <config.json> --receipt <receipt.json> [--attempt-id <uuid>] [--json] [--dry-run]
```

- `--dry-run` — validates local publication evidence and prints config/build/artifact
  identity without resolving secrets, obtaining certificates or touching hosts.
- `--json` — prints the machine-readable `RunSummary` instead of the
  human-readable summary lines.
- `--attempt-id` — binds the result to the caller's fresh UUID; reuse is rejected.
- `--skip-purge` — rejected for publication; configured CDN gates are mandatory.

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

`run` exits zero only when every configured host deployment and health gate
succeeds, all artifact checks pass, the configured CDN purge succeeds, every
configured version probe serves the requested build, and the result is persisted.
If at least one host changed before a gate
failed, the JSON summary sets `recoveryRequired: true`; old versioned assets
are retained and the human summary says recovery is required. Old-build cleanup
and optional notification/help-sync failures remain non-blocking. Private staging
cleanup and result persistence failures block successful completion.

`check` exits non-zero when config validation, version, secret resolution/cert
signing, SSH reachability, or a health check itself fails. Soft disk/memory
threshold warnings do not fail `check`.

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

- **QW3:** superseded by v0.4.0 below. Shared directories require recursive
  ownership for rsync to preserve nested mtimes; top-level write permission
  alone is insufficient.

- **QW4 (install gate):** Dependency installation now skips `corepack use`
  and `yarn install --immutable` entirely when the remote manifest hash
  (sha256 of `package.json` + `yarn.lock`) matches the stamp file
  `<remotePath>/.deploy-install-stamp` AND `node_modules` exists on the
  remote. Any doubt (missing/corrupt stamp or `node_modules`) forces a fresh
  install — fail-safe. The immutable install refuses dependency resolution
  that would alter the accepted lockfile, so equal build labels cannot hide
  site-specific dependency drift.

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

## Release transport and verification (v0.4.0)

```bash
znvault webdeploy verify zn-web-prod --config-file webdeploy.config.json --receipt .release-artifacts/publication.json --expected-build 30542 --json
```

`verify` returns zero only when **every configured host** passes its health
checks, has the exact reviewed managed-nginx file digest and enabled-link target,
has every configured upstream listener reachable, and serves the exact expected
build. It requires `healthChecks`, `nginx.config` and `verify` configuration; an
approved predecessor digest does not qualify. Failed hosts do not skip checks on
other hosts. It reads config aliases without resolving deployment secrets, and
never transfers files, installs dependencies, reloads services, syncs help or
purges CDN state. A sufficiently valid local signed SSH certificate is reused;
otherwise the CLI's supported SSH signing API obtains one. Authentication can
therefore require an available Vault; the command never unseals it.

Read-only PM2 checks connect to the existing PM2 RPC socket rather than running
`pm2 jlist`, which could launch a missing daemon. Unsupported PM2 installation
layouts or unavailable RPC fail closed. Read-only nginx verification checks disk
identity/digest and live health/listeners/version without `nginx -t/-T`, because
those commands can create log files. Normal deployments retain syntax, loaded
include, drift and rollback gates.

Static deployment opens permissions recursively on the selected build and each
explicitly enumerated shared entry. All other top-level numeric build directories
are excluded, including short historic names. Shared nested directories retain
ownership needed for rsync mtimes. An already-established remote shell owns an EXIT/HUP/INT/TERM trap before
permissions open; restoration needs no new SSH authentication after a transfer,
opening failure, disconnect or invocation expiry. It restores the root and all
safe descendants without following links, reports unsafe paths after best-effort
cleanup, and never lets one injected link suppress all restoration. Local source symlinks/special files and unsafe remote paths or
symlink trees are rejected. Shared rsync filters protect retained numeric builds.
Cleanup still follows all rollout, health, purge and version gates.

Each invocation owns a mode-0700 temporary SSH socket directory, shares its
connections with rsync, and closes only its own masters on return, failure or
handled termination signals. User-configured or another invocation's masters are
never reused. Deploy invocations require at least 35 minutes of certificate validity before
starting (renewing through the supported signing API if needed), run for at most
30 minutes, and refuse a new host with less than five minutes remaining. Certificate
reuse/signing happens before deployment starts; it is not repeated mid-rollout.
This certificate validity budget is separate from the Vault unseal window: the
plugin neither unseals Vault nor changes/extends its unseal TTL. Verify
sessions expire at certificate expiry or one hour, whichever comes first. No
master is extended for recovery; idle masters also expire after 60 seconds. Like other process
cleanup, immediate removal cannot be guaranteed after SIGKILL or power loss.

Dependency hash, success stamp and `node_modules` presence are probed in one SSH
round trip. Missing or unreadable manifests cannot authorize an install skip.
Help synchronization hashes sorted filenames and Markdown bytes, skipping only
content previously accepted by the same endpoint from the same local directory.
Its private local stamp contains only a content digest, never a key or credential
hash. HTTP/transport failures never update the stamp and remain non-blocking;
key-only rotation does not require uploading already accepted unchanged content.

`run --json` and `verify --json` retain the summary fields and add `timings`:
`{phase, host?, durationMs, success, transferredBytes?}[]`. Host deployment records
also include `durationMs` and, when available, `transferredBytes`. Byte counts are
rsync's **total transferred file size**, not compressed wire bytes. Nested timing
entries overlap; do not sum them as total elapsed time. Thrown preflight failures
produce `{config, success:false, timings, error}` with nonzero exit status. No
speed-up claim is made until a separately authorized rolling release is measured.

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
