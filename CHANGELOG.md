# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-02

### Added

- Native dsh cordis bundle: Honcho memory loop — recall on agent creation,
  capture on turn end, durable outbox with retry on next session.
- Recall: bounded peer context (peer card + representation) injected into the
  agent inbox before the first model call, tagged with a `honcho-recall`
  source.
- Capture: user prompt (human-authored only — synthetic injected contexts are
  skipped) paired with the final assistant reply, redacted before truncation,
  queued to the durable outbox, and uploaded asynchronously.
- Outbox: atomic per-turn JSON files under
  `$DSH_HOME/dsh-plugin-honcho/outbox/` with cross-process file locking and
  poison-pill isolation for corrupt entries.
- Credentials: `HONCHO_API_KEY` env overrides the key while
  `$DSH_HOME/honcho.json` supplies `baseUrl`/`workspaceId`/`peerId`; the
  plugin silently disables itself without an apiKey.
- Fail-open containment on every subscription; teardown drains in-flight
  uploads via a named cordis effect.
- Real-smoke fixes: env key must not shadow file workspace config, injection
  goes through the agent facade's `inject` (not the inbox facade), and only
  `source.kind === "user"` messages are captured as prompts.
