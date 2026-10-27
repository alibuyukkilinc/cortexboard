# Security

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository (private vulnerability reporting). You will get an
answer within a week; if the report is confirmed, a fix and an advisory follow, and you are credited unless
you ask not to be.

Useful to include: the version (`npx cortexboard --version` or `package.json`), whether it is single-project
mode (`cortexboard start`) or the team server (`cortexboard hub start`), and the steps to reproduce.

## Supported versions

Only the latest minor release gets security fixes while the project is at 0.x.

## What Cortex protects, in short

- **Single-project mode** answers only on localhost and rejects other `Host` headers (DNS rebinding).
  Actor tokens live in `.cortex/.secrets.yaml` (owner-only, never committed). The board uses a signed
  10-minute login link and then a session whose key is stored only as a hash; cookie writes need a CSRF
  header.
- **The team server** stores passwords with scrypt and every token (sessions, invites, agents) only as a
  SHA-256 hash, rate-limits every door, and checks each member's role and visibility on every route. Run it
  behind HTTPS if it is reachable from a network.
- Cortex never calls an LLM and never sends project data anywhere.
