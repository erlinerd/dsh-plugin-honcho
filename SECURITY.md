# Security Policy

## Reporting

Please open a private security advisory via GitHub (Security → Advisories) or
contact the maintainer directly. Do not open a public issue for exploitable
findings.

## Scope

This plugin exports agent conversation content (user prompts and assistant
replies) to a Honcho instance you configure, and injects recalled peer context
into agent sessions. Treat the configured Honcho endpoint as trusted: captured
text is redacted (bearer tokens, key assignments) and truncated before leaving
the machine, but it does leave the machine. Set `capturePrompts`/
`captureResponses` to `false` or disable the plugin for sensitive workspaces.

## Data handling

- Credentials resolve from `HONCHO_API_KEY` env (key only) or
  `$DSH_HOME/honcho.json` (`apiKey`, optional `baseUrl`/`workspaceId`/`peerId`
  overrides) — never committed; the plugin disables itself without an apiKey.
- The API key is sent only to the configured `baseUrl`.
- Upload failures stay in the local outbox and are retried on the next
  session; nothing is buffered remotely on failure.
