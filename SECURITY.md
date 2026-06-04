# Security Policy

## Reporting a vulnerability

Please report security issues privately using GitHub's
[private vulnerability reporting](https://github.com/asigdel29/agent-canvas/security/advisories/new)
rather than opening a public issue. We aim to acknowledge a report within
a few days.

## Self-host hardening notes

- **Generate fresh secrets.** `./scripts/setup.sh` fills `JWT_SECRET`,
  `SSE_TOKEN_SECRET`, `AUTH_STATE_SECRET`, and `VAULT_KEY` with random
  32-byte hex. Never reuse the example values.
- **`AUTH_MODE=open` disables tenant isolation.** Every authenticated
  user is treated as an owner of every workspace. Only run open mode
  behind a trusted network boundary.
- **AI keys are bring-your-own.** Per-user keys live in the browser and
  travel per-request; they are never persisted server-side.
- **Set `VAULT_KEY`** in any deployment that stores connector
  credentials, so they are encrypted at rest (AES-256-GCM) rather than
  using the no-encryption development stub.
