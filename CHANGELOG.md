# Changelog

All notable changes to `@zincapp/znvault-plugin-webdeploy` are documented in
this file.

## 0.2.1

Build/publish tooling only — no runtime change; plugin behavior identical to 0.2.0.

- Pin `vitest` to the `~4.0.17` line: `vitest` 4.1's bundled `rolldown` imports
  `node:util`'s `styleText` (Node 20.4+ only), which broke the Node 18 CI leg.
- Drop the `npm-publish` GitHub environment from the release workflow; publish
  via bare OIDC trusted publishing (repo + workflow binding). First release
  published from CI with provenance.

## 0.2.0

Performance optimizations: four non-breaking speed improvements to deployment
workflow. **Security model and result contract unchanged.** Exit codes,
warnings, third-party integrations (Slack, Cloudflare) work as before.

- **QW3 (scoped permissions):** `chown`/`chmod` during static asset rsync now
  targets written paths only — Phase A recurses on the new `<build>/` dir,
  Phase B is non-recursive on the webroot. Avoids expensive permission changes
  over dozens of pre-existing versioned directories.
- **QW4 (install gate):** `corepack use` + `yarn install` skipped when remote
  manifest hash (sha256 of `package.json` + `yarn.lock`) matches
  `<remotePath>/.deploy-install-stamp` AND `node_modules` exists. Fail-safe:
  any doubt forces a fresh install.
- **QW5 (poll instead of sleep):** PM2 settle and version verification poll
  every 250ms up to ceilings (2s and 5s respectively) instead of fixed sleeps.
  Result strings and exit semantics identical to before.
- **QW6 (batched health):** Health checks run as a single remote shell script
  emitting `idx|STATUS|detail` lines, parsed locally. Output, semantics, and
  warnings identical to before.

## 0.1.0

Initial release.

- `znvault webdeploy` CLI plugin: `run`, `check`, `status`, and
  `config list|show|validate|import` subcommands, registered via the
  standard `znvault-cli` plugin loader (default-export factory).
- Named, local config store at `~/.znvault/webdeploy/configs.json` (mode
  0600), validated on import and on `config validate`.
- Vault-backed secret resolution: `alias:path.field` references resolved via
  `GET /v1/secrets/alias/{alias}` + `POST /v1/secrets/{id}/decrypt`, resolved
  once in memory per run; plain/`literal:` values pass through untouched.
- Universal output redaction (`Redactor`, longest-match-first) covering
  human-readable summaries, `--json` output, and `--dry-run` plans.
- Alias-only enforcement for secret-designated config fields:
  `cdn.apiToken`, secret-like `app.env` keys, every `app.files` value,
  `notify.webhook`, `notify.helpSync.key`.
- SSH-CA certificate management: per-run short-TTL signing via
  `POST /v1/ssh/sign`, principal + 5-minute expiry validation, cached at a
  dedicated `<key>-webdeploy-cert.pub` path that never collides with the
  interactive `znvault ssh connect` certificate.
- SSH/rsync execution layer over system OpenSSH + GNU rsync (rejects
  macOS `openrsync` and rsync < 3.1.0); remote file writes piped over SSH
  stdin (never argv), written mode 0600, and skipped when content is
  unchanged (remote `sha256sum` comparison).
- Gated rolling deploy per host: app rsync → rendered `.env`/`app.files` →
  `corepack`/`yarn install` → two-phase static rsync (versioned dir, then
  atomic `--delay-updates` shared-file switchover) → PM2 zero-downtime
  reload (or first start) → nginx reload → health-check gate before moving
  to the next host.
- Seven health-check types: `systemd`, `http`, `pm2`, `ports`, `file`,
  `disk`, `memory`.
- Post-deploy pipeline once at least one host succeeds: Cloudflare cache
  purge → propagation wait → per-host version verification → old
  versioned-build cleanup (default retention: 50) → help-content sync →
  webhook notification (both non-blocking).
- Exit-code semantics: non-zero only when a host deploy failed or was
  skipped; CDN purge failures, version-verify mismatches, and health
  warnings are recorded as summary warnings, not failures.
- Per-config exclusive locking (`O_CREAT|O_EXCL` lock file in the OS tmp
  dir) with `LockHeldError`; a lock is only ever reclaimed when its PID is
  provably dead (`ESRCH`), never stolen from a live or unprobeable process.
- 69 unit tests (vitest), fully dependency-injected — no real SSH, host, or
  vault connection required to run the suite.
