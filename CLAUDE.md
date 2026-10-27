# Cortex (this repository)

This repo is Cortex itself, and it runs on its own knowledge in `.cortex/`.
The MCP server for this repo is configured in `.mcp.json` (runs from source, actor `ai-agent`).
If the cortex tools are missing, run `npm install` and restart the session; the REST API also works
(`node dist/cli.js start`, token in `.cortex/.secrets.yaml`).
On the owner's machine a `local`-scope `cortex` MCP entry overrides `.mcp.json` and connects to the hub
(`--hub https://<hub> --project cortex`, agent token + chat key): approvals are asked as the
hub user. `/mcp` then warns "Conflicting scopes"; that is expected, keep the `.mcp.json` entry for contributors.

Commands: `npm test` · `npm run typecheck` · `npm run build`.
Knowledge nodes you write become drafts the owner approves. Write Cortex content in the project language (see the first rule in the brief).

<!-- cortex:start -->
## Project knowledge: Cortex
This project's knowledge lives in Cortex, not in markdown files.
- Session start: call `cortex_brief`, then `cortex_inbox` for questions and issues waiting on you.
- Before changing code you don't fully understand: `cortex_search`, then `cortex_tree` / `cortex_node`.
- Before editing files: `cortex_code_context(files)` shows the knowledge, decisions and open items that cover them.
- Unsure? Open a question (`cortex_ask` or `cortex_create_item` type "question") instead of assuming.
- After a meaningful change: `cortex_log_activity` (what, why, files, commit), and update the relevant node.
- Before you finish: `cortex_update_status` (where the project stands, what is next); the brief marks it when stale.
- When a piece of work is done, have the person approve in this chat: `cortex_review_drafts` for your drafts, `cortex_pending_approvals` / `cortex_ask_human` for decisions, questions and done. Only their own answer counts: never answer for them.
- When the person states a lasting decision or rule, offer `cortex_capture`: it belongs in Cortex, not in your private memory.
Do not update docs in .md files; update Cortex.
<!-- cortex:end -->
