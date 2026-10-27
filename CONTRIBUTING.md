# Contributing to Cortex

Thanks for helping. This file covers how the repository is laid out, how to run and test it, and a few
habits the project keeps on purpose.

## Setup

Node.js 22.16 or newer (earlier 22.x builds of `node:sqlite` have no FTS5). Nothing else.

```bash
npm install
npm test               # node:test through tsx, every file in test/
npm run typecheck      # server and board
npm run lint           # oxlint with type information; warnings fail too
npm run format:check   # prettier
npm run build          # server to dist/, board to dist/web
npm run smoke          # pack, install into an empty folder, init, start, check the API and the board
```

`npm run dev -- <command>` runs the CLI from source (`npm run dev -- start`, `npm run dev -- report`).
`npm run dev:web` serves the board with hot reload on :5173, proxied to the API on :4747.

## Tests

- One file per area in `test/`, plain `node:test` and `assert`. Helpers in `test/helpers.ts`:
  `tempProject()` for a project in a temp folder, `gitProject()` for one inside a real git repository with
  a small codebase and real commits (staleness is always tested against git, never mocked).
- Count things instead of timing them: CI machines are shared, and a count of git calls or folder listings
  does not flake (see `test/perf.test.ts`).
- The CLI is tested as a child process from source (`test/cli.test.ts`), because CI runs the tests before it
  builds.
- The web board is tested with Vitest and happy-dom in `web/test/` (`npm run test:web`), and end to end
  with Playwright and axe in `e2e/` (`npm run e2e`, after a build).
- When you fix a bug, write the test first and see it fail. The commit message should say what the test
  guards and, where you measured something, the number before and after.

## CI

`.github/workflows/ci.yml` runs typecheck, tests, build and the install smoke test on Ubuntu, Windows and
macOS, each on Node 22.16 (the oldest supported) and 24: six legs. Lint and format run once, on the
Ubuntu / Node 24 leg, because they give the same answer everywhere.

Windows matters: paths, line endings (`.cortex/.gitattributes` pins LF) and process spawning behave
differently there, and several real bugs only showed up on it.

## Habits this project keeps

- **The rules files belong to people.** `.cortex/rules/` is edited by humans only; Cortex enforces the
  rules and explains violations, and AIs cannot change them. Do not add code paths that let an AI write
  there.
- **Knowledge in Turkish, code in English.** This repository runs on its own Cortex, and its knowledge
  tree (`.cortex/tree/`) is written in Turkish, as its global rule says. Code, identifiers, commit
  messages and these repository documents are in English. The maintainers' cards, discussions and
  activity logs are not published; open a GitHub issue or discussion instead.
- **Knowledge lives in Cortex, not in Markdown.** Do not add design notes as `.md` files; update the
  relevant node in `.cortex/tree/` (or through the MCP tools), and log what you changed and why with
  `cortex_log_activity`.
- **Cortex never calls an LLM.** Reports, search and staleness are counted and computed, so they cost
  nothing and give the same answer every time.
- **Say why.** Comments explain why something is the way it is, not what the next line does; commit
  messages lead with the reason.

## Issues and pull requests

- Bugs and ideas go to GitHub issues (there are templates); security problems go through private
  reporting, see [SECURITY.md](SECURITY.md).
- Keep a pull request to one change, with its test. CI must be green: typecheck, lint, format, tests and
  the smoke test.
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Dependencies

`react`, `react-dom`, `marked`, `dompurify` and the fonts are `devDependencies`, and that is correct, not an
oversight: Vite bundles them into `dist/web` at build time, and the published package contains only
`dist`. `npm run smoke` proves it by installing the packed tarball into an empty folder and opening the
board. Moving them to `dependencies` would only make every user download them for nothing.

## Releasing

Maintainers: update `CHANGELOG.md`, bump the version in `package.json`, commit, then tag `vX.Y.Z` and push
the tag. `.github/workflows/release.yml` runs the full CI matrix, publishes to npm with provenance and
creates the GitHub release with that version's CHANGELOG section as its notes.
