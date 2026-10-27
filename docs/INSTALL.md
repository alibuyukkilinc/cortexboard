# Installing Cortex

This guide assumes nothing. If you have never used Node.js, MCP or a terminal much, start at the top and
follow it in order; if you have, jump to [Choose your setup](#choose-your-setup).

🇹🇷 Türkçesi: [KURULUM.md](KURULUM.md)

- [What you need](#what-you-need)
- [Choose your setup](#choose-your-setup)
- [Setup A: one project on your computer](#setup-a-one-project-on-your-computer) (most people)
- [Connect your AI tool](#connect-your-ai-tool)
- [Setup B: a team server (hub)](#setup-b-a-team-server-hub)
- [Optional: search by meaning](#optional-search-by-meaning)
- [Upgrading](#upgrading)
- [Troubleshooting](#troubleshooting)
- [Removing Cortex](#removing-cortex)

---

## What you need

| | Why | How to check |
|---|---|---|
| **Node.js 22.16 or newer** | Cortex is a Node.js program. Nothing else to install: no database, no Docker, no API key. | `node -v` prints `v22.16.0` or higher |
| **git** (recommended) | Cortex notices when knowledge goes out of date by looking at your commits. Without git everything else works; that one feature stays off. | `git --version` |
| **An AI coding tool that speaks MCP** | Claude Code, Cursor, VS Code with Copilot, Claude Desktop, Codex… MCP is how the AI reads and writes Cortex. | (see [Connect your AI tool](#connect-your-ai-tool)) |

**Installing Node.js:** download the **LTS** version from [nodejs.org](https://nodejs.org) and run the
installer (Windows, macOS), or use your package manager on Linux. Open a **new** terminal afterwards and
check `node -v`. It comes with `npm` and `npx`, which is all Cortex needs.

> **A terminal** is the "Command Prompt" / "PowerShell" on Windows, "Terminal" on macOS. Every command
> below is typed there, inside your project's folder (`cd path/to/your/project`).

---

## Choose your setup

| | **A. One project, your computer** | **B. Team server (hub)** |
|---|---|---|
| For | One person (and their AIs) on one or more repositories | A team: several people, several projects, AI agents |
| Start with | `npx cortexboard init` then `npx cortexboard start` | `npx cortexboard hub init` then `npx cortexboard hub start` |
| Who can reach it | Only this computer (localhost) | Anyone you invite, over HTTPS |
| Sign-in | A one-time link printed in the terminal, no password | Email + password (invite link), AI agents with tokens |
| Roles | You (human) and your AI | Owner, Admin, Member, Viewer; AI Reader, Contributor, Trusted; per project |
| Where the knowledge lives | In the repository: `.cortex/`, committed with your code | Still in each repository's `.cortex/`; the hub only stores people and memberships |
| AI connection | MCP started in the project folder | MCP to the hub with an agent token, or MCP over HTTP for remote AIs |

Start with **A**. You can move a project to a hub later without changing anything in it: the hub just
registers the folder.

**Running the commands: three ways.** All examples use `npx cortexboard …`, which downloads the package on
first use and needs no install. If you prefer:

| | Command | When |
|---|---|---|
| `npx` (default) | `npx cortexboard start` | Nothing to install; always runs the version you ask for |
| Global | `npm install -g cortexboard`, then `cortexboard start` | You use it daily in many projects |
| Project dependency | `npm install -D cortexboard`, then `npx cortexboard start` | The whole team gets the same version from `package.json` |

---

## Setup A: one project on your computer

### 1. Create `.cortex/`

In your project folder:

```bash
npx cortexboard init
```

It asks which top-level knowledge branches the project needs (backend, frontend, mobile…); press Enter
for all of them, or answer with numbers and your own names. To skip the question:

```bash
npx cortexboard init --branches backend,frontend,payments --lang en
```

`--lang` is the language your AIs will write knowledge in (`en`, `tr`, …; default: your computer's).
It prints two **tokens** (one for you, one for your AI). You rarely need them; they are saved in
`.cortex/.secrets.yaml`, which is never committed.

What it created:

```
.cortex/
├── cortex.config.yaml   people and AIs, approval policy, time zone      → commit
├── rules/               the rules every AI follows (only people edit)   → commit
├── tree/                the knowledge, one Markdown file per page       → commit
├── items/               tasks, issues, questions, decisions, their files → commit
├── activity/            what each AI did and why                        → commit
├── drafts/              AI changes waiting for your approval            → commit
├── .secrets.yaml        tokens                                          → never (git-ignored)
├── .sessions.json       board sign-ins                                  → never (git-ignored)
└── .index/              search cache, rebuilt from the files            → never (git-ignored)
```

Commit it like any other code: `git add .cortex && git commit -m "Add Cortex"`. Everything in it is plain
text, readable in any editor and reviewable in pull requests.

### 2. Open the board

```bash
npx cortexboard start
```

It prints the address (`http://localhost:4747`) and a **login link**. Open the link in your browser: you
are in, no password. The link works for 10 minutes; `npx cortexboard login` prints a new one. Keep the
terminal open while you use the board (Ctrl+C stops it).

Port 4747 taken? `npx cortexboard start --port 4800`.

### 3. Connect your AI and fill the tree

`init` opens a task for your AI right away: **"Fill the knowledge tree from the code (first setup)"**,
assigned to `@ai` and visible on the board. [Connect your AI tool](#connect-your-ai-tool) (next section),
then just tell your AI "start your Cortex task". It finds the task in its inbox, and until the tree is
filled the brief tells it to do that first. It reads the codebase and writes the knowledge tree. To hand
the same text over yourself, `npx cortexboard bootstrap` prints it.

Every page it
writes arrives as a **draft**; approve them on the board under **Approvals** (you can approve many at
once). From then on the AI starts every session by reading a short brief instead of re-reading the
project, and asks you in **Notifications** when it is unsure.

---

### 4. Backups (optional)

A project that is not on a hub can back up its knowledge to the same places (BunnyCDN or Google Drive):
**Backups** in the board's menu, with the same settings as the hub's (section 8 of Setup B). The archive
is `.cortex` without tokens, sessions, the search index and personal views; settings go in
`cortex.config.yaml` (`backup:`), keys in `.cortex/backup.secrets.yaml` (git-ignored). Timed backups run
while `cortexboard start` is open.

A restore replaces `.cortex` in place; what was there is moved to `.cortex/.restore/before-<time>` first.
Restart the board and your AI sessions afterwards.

```bash
npx cortexboard backup setup --zone my-backups --key <zone password>   # or --provider gdrive ...
npx cortexboard backup                # now
npx cortexboard backup list
npx cortexboard backup restore <name or downloaded file> --passphrase <key>
```

## Connect your AI tool

Cortex runs as an **MCP server** that your AI tool starts by itself. The command is always:

```
npx cortexboard mcp --actor ai-agent
```

started **in the project folder** (or with `--dir <project folder>` when the tool starts it somewhere
else). Pick your tool:

**Claude Code** (in the project folder):

```bash
claude mcp add cortex -- npx cortexboard mcp --actor ai-agent
```

**Cursor** (`.cursor/mcp.json` in the project) and **any tool that reads `.mcp.json`**:

```json
{
  "mcpServers": {
    "cortex": { "command": "npx", "args": ["cortexboard", "mcp", "--actor", "ai-agent"] }
  }
}
```

**VS Code with Copilot** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "cortex": { "type": "stdio", "command": "npx", "args": ["cortexboard", "mcp", "--actor", "ai-agent"] }
  }
}
```

**Claude Desktop** (Settings → Developer → Edit config). It does not start servers in your project, so
name the project folder:

```json
{
  "mcpServers": {
    "cortex": { "command": "npx", "args": ["cortexboard", "mcp", "--actor", "ai-agent", "--dir", "C:/code/shop"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.cortex]
command = "npx"
args = ["cortexboard", "mcp", "--actor", "ai-agent", "--dir", "/home/me/code/shop"]
```

> **Windows and `npx`:** if a tool says it cannot find `npx`, use `"command": "cmd"` and put
> `"/c", "npx"` at the start of `args`.

To help the AI use it well, `npx cortexboard init --agent-files` adds a short Cortex section to an existing
`CLAUDE.md` / `AGENTS.md`. Check it works: ask your AI to *"call cortex_brief"*. It should answer with the
project summary and branches.

**More than one AI?** Add actors in `.cortex/cortex.config.yaml` (e.g. `{ id: cursor, kind: ai }`) and
start each with its own `--actor`, so the activity feed shows who did what.

### Approve from the AI chat

You do not have to open the board to keep Cortex current. When the AI finishes a piece of work, it asks you
in the chat: approve its drafts, accept a decision, answer a question, close a task. You answer, and Cortex
records the answer as yours, with where it came from.

- **Cortex writes the question itself**, from the real record: the draft's diff, the decision's text, the
  task card. The AI's note is shown under it as context only.
- **The answer comes from your AI client's own dialog** (MCP *elicitation*) and never passes through the
  model. An AI cannot answer for you.
- **Every answer is recorded with its source:** your id, the AI that asked, the session, and a hash of what
  you were shown. On the board it carries a **"from the AI chat"** badge. Under **Activity → Answered in
  the AI chat** you can see all of them and **undo** any one; the card goes back to how it was.
- **When the AI finishes work,** it asks you to review its drafts (`cortex_review_drafts`). When you state a
  lasting decision or rule, it offers to save it (`cortex_capture`). Anything you confirm is written as yours,
  active at once, with no draft.

The approvals are recorded as the first human actor in `cortex.config.yaml`; pick another with
`--human <id>`.

**Clients.** What we know about MCP elicitation today. Only the SDK test client has been tested with
Cortex so far; the rest comes from each client's documentation or bug tracker.

| Client | Elicitation | What to do |
|---|---|---|
| Claude Code | supported (form dialogs) | nothing |
| Cursor | listed as supported | nothing; tell us if the dialog does not appear |
| Codex CLI | advertised, but requests are declined without a dialog ([openai/codex#45621](https://github.com/openai/codex/issues/45621)) | start with `--no-elicitation` |
| opencode | advertised, but requests are never answered ([anomalyco/opencode#51856](https://github.com/anomalyco/opencode/issues/51856)) | start with `--no-elicitation` |
| VS Code Copilot, Claude Desktop, others | not checked yet | try it; if no dialog shows, `--no-elicitation` |

**Without elicitation** (or with `--no-elicitation`) the AI quotes your words (`cortex_record_human_answer`).
What happens next is set in `cortex.config.yaml`:

```yaml
chat:
  relayed: accept      # accept: applied, marked "unverified" (default on your own computer)
                       # pending: waits for you under Approvals → "Relayed from the AI chat" (default on a hub)
                       # off: refused, answer on the board
  max_batch: 10        # drafts in one question
  relayed_human_only: false   # true: a relayed answer may also accept decisions and close tasks
```

A question left unanswered for 10 minutes gives up and changes nothing.

---

## Setup B: a team server (hub)

One server, many projects, people with passwords, AI agents with tokens. Each project still keeps its
knowledge in its own repository; the hub reads those folders.

### 1. Create the hub (on the server)

```bash
npx cortexboard hub init --org "Acme" --admin-email you@acme.com --admin-name "Your Name" --public-url https://cortex.acme.com
```

It stores its data in `~/.cortex/hub` (change with `--dir` or `CORTEX_HUB`): people, password hashes,
sessions, agents and memberships. **Back this folder up; never commit it.** It prints a link to set your
password (valid 48 hours).

### 2. Register projects

The server needs a checkout of each repository. Then:

```bash
npx cortexboard hub add-project /srv/repos/shop                                            # already has .cortex/
npx cortexboard hub add-project /srv/repos/blog --init --lang en --branches backend,frontend # creates its knowledge first
```

or on the board: **Organization → Projects → Add project**.

**Where the knowledge lives.** A project created on the hub (`--init`) keeps its knowledge in the hub's
folder (`~/.cortex/hub/projects/<id>`), not in the code repository. Developers' clones have no `.cortex/`
to read out of date or edit around the hub, and nobody has to commit what the hub wrote: the hub commits it
in that folder every minute (`commit_seconds` in `hub.yaml`) and never pushes. Back that folder up with the
rest of the hub. `--in-repo` keeps the old layout (`<repo>/.cortex`, committed with the code). A repository
that already has `.cortex/` is registered as it is; `cortexboard hub move-knowledge <project>` (hub stopped)
moves it into the hub and removes it from the checkout, and if it was committed there, you commit its removal.

A project that never used Cortex (`--init`) starts as a bare skeleton: the branches you chose and a task
for the AI, **"Fill the knowledge tree from the code"**. The first AI agent you add to the project
([step 5](#5-connect-ai-agents-to-the-hub)) finds it in its inbox; nobody has to run a command on the
server and paste text. With the **Contributor** role its writes arrive as drafts, which the team approves
(in bulk) under **Approvals**. On a large project the AI can work in passes, leaving a note on the task
where it stopped.

### 3. Run it behind HTTPS

The hub signs people in with passwords, so it must be reached over **HTTPS**. Run it on the server's own
loopback and put a reverse proxy in front. With [Caddy](https://caddyserver.com) (automatic certificates):

```
# /etc/caddy/Caddyfile
cortex.acme.com {
  reverse_proxy 127.0.0.1:4747
}
```

and tell the hub it sits behind that proxy, in `~/.cortex/hub/hub.yaml`:

```yaml
public_url: https://cortex.acme.com
trust_proxy: true                 # take https and the client address from the proxy
allowed_hosts: [cortex.acme.com]  # answer only to this name
```

The same three settings can come from environment variables, which win over `hub.yaml`; when the address
changes (a tunnel, say), change one variable: `CORTEX_PUBLIC_URL`, `CORTEX_TRUST_PROXY` (`1`),
`CORTEX_ALLOWED_HOSTS` (comma list, e.g. `cortex.acme.com,localhost,127.0.0.1`). The hub adds security
headers to every response (never framed, scripts from its own origin only), and HSTS behind https.

Start it (keep it running with systemd, pm2 or your platform's service manager):

```bash
npx cortexboard hub start            # listens on 127.0.0.1:4747
```

<details>
<summary>systemd example</summary>

```ini
# /etc/systemd/system/cortex-hub.service
[Unit]
Description=Cortex hub
After=network.target

[Service]
User=cortex
ExecStart=/usr/bin/npx --yes cortexboard@0.2.2 hub start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now cortex-hub`
</details>

Listening on the network directly (`hub start --host 0.0.0.0`) without HTTPS is possible for a trusted
LAN, but session cookies are then marked Secure and plain-http sign-in will not stick; set
`cookie_secure: false` in `hub.yaml` only if you understand that passwords travel unencrypted.

### 4. Invite people and add AI agents

On the board, **Organization**:
- **People → Add person**: email, name, first project and role. You get a one-time link (48 hours) to send
  them; they choose their password. The same button later works as a password reset.
- **AI agents → Add AI agent**: an id (e.g. `claude-code`), first project and role. The **token is shown
  once**; copy it.
- In each project, **Members** sets the role and what each member **sees**: everything, only their own
  items, optionally only some branches (e.g. only `mobile`).

| Role | For | Can |
|---|---|---|
| Owner, Admin | people | everything, including members and rules |
| Member | people | work on items and knowledge, approve AI drafts |
| Viewer | people | read, ask and answer questions |
| Reader | AI | read |
| Contributor | AI | work on items; knowledge writes wait for approval |
| Trusted | AI | like Contributor, knowledge writes apply directly |

### 5. Connect AI agents to the hub

On a developer's machine (the tool starts it; no project folder needed):

```bash
claude mcp add cortex -- npx cortexboard mcp --hub https://cortex.acme.com --project shop --token <agent token>
```

or with environment variables `CORTEX_HUB_URL`, `CORTEX_PROJECT`, `CORTEX_TOKEN`. An AI that does not run
on your machines (ChatGPT, a hosted agent) connects to **MCP over HTTP** at
`https://cortex.acme.com/mcp/p/shop` with `Authorization: Bearer <agent token>`. Whatever the path, the
agent's role and visibility apply.

**Approving from the AI chat on the hub** ([how it works](#approve-from-the-ai-chat)): each person makes a
**chat key** on the board: avatar menu → *Approve from the AI chat*. A key is for one project and is shown
only once. Add it to your own MCP command:

```bash
claude mcp add cortex -- npx cortexboard mcp --hub https://cortex.acme.com --project shop --token <agent token> --human-token <your chat key>
```

(or `CORTEX_HUMAN_TOKEN`). Your answers are then recorded as you, with your role: a Viewer is never asked
to approve a draft. A chat key can only read its project and record answers given in the chat. It is not a
password for the board, and you can revoke it from the same menu. MCP over HTTP cannot ask questions in
the chat (it keeps no session); use the command above.

### 6. Linked projects: one app reading another's knowledge

One repository is one project. When a mobile app needs its backend's API, auth flow and rules, link them
on the board: **Organization → Projects → Linked projects → Link**. With "add this project's AI agents as
Readers" ticked, the mobile project's agents become Readers of the backend in the same step. The board
writes the link to the project's `cortex.config.yaml`; writing it by hand works too:

```yaml
linked: [backend]
```

The mobile agent keeps its single MCP connection. `cortex_brief` lists the linked projects, and
`cortex_search`, `cortex_tree`, `cortex_node`, `cortex_items` and `cortex_item` take `project: "backend"`
to read there. A link is not access: the agent must also be a member of the backend (a Reader is
enough), and that membership's branch and scope limits apply. Linked reads are read-only whatever the
role over there; questions and writes stay in the agent's own project.

### 7. Keeping the hub's checkouts current

The hub reads each project from a folder on its own machine. To keep that checkout up to date with what
developers push (fresh code is what staleness compares against), let the hub pull:

```yaml
# ~/.cortex/hub/hub.yaml
pull_minutes: 5
```

or pull by hand with `cortexboard hub pull [project]`, or with **Pull** on Organization → Projects.
It only fast-forwards and never commits or pushes the code repository. For a project whose knowledge is
still in the repository (`--in-repo`), what the hub wrote stays in its checkout, and the Projects page counts
those files ("3 to commit") until a person commits them. A diverged branch, local
commits or local edits the incoming commits touch stop the pull with the reason; nothing is reset or
merged. Pulling needs read access to the remote from the hub machine (no password prompt can be answered).

### 8. Backups (BunnyCDN or Google Drive)

Backs up the hub (people, agents, memberships) and every project's knowledge as one encrypted file, to a
BunnyCDN storage zone or a Google Drive folder. On the board: **Organization → Backups**.

- **BunnyCDN:** the zone's name, region and password (Bunny → Storage → the zone → FTP & API Access →
  Password).
- **Google Drive:** in Google Cloud → APIs & Services, enable the **Google Drive API**, create an OAuth
  client of type **TVs and Limited Input devices**, and set the OAuth consent screen to **In production**
  (while it is "Testing", Google drops the sign-in after 7 days). Paste the client ID and secret, save,
  then **Connect Google Drive**: open the address shown, enter the code, allow access. Cortex asks only
  for `drive.file`: it sees the files it made, nothing else in the Drive. The backups go in a folder
  named after the folder setting; another machine that connects the same account finds it again.
- **Encryption key:** type your own (12+ characters) or leave it empty and one is made and shown once.
  Keep it somewhere other than this machine: backups cannot be opened without it. You can change it
  later; older backups still need the key they were made with.

Then **Back up now**; with `Every (hours)` above 0 the hub backs itself up on that interval. The newest
`keep` archives stay, older ones are deleted. Each backup in the list can be **downloaded** (the encrypted
file) or **restored**.

**Restoring from the board** prepares the backup and applies it when the hub restarts: **Restart the hub
now** does that from the board (on Windows the hub opens in a new window; under systemd, or with
`CORTEX_RESTART=exit`, it exits and the service manager starts it again). The hub as it was is kept
beside it (`hub-before-restore-<time>`): to go back, stop the hub and rename it back. This machine's
address, port and backup settings stay. If the backup was made with another key (say, the hub was
reinstalled), give that key and tick "use this key from now on", so later backups keep it.

After a restore on another machine, point each project at its code folder there: **Organization →
Projects → Change** next to the folder (or `cortexboard hub set-path <project> <folder>`). A folder that
does not exist is marked. Knowledge the hub holds in its own folder does not move.

In an archive: a consistent copy of `hub.db`, `hub.yaml`, the hub-held projects' knowledge folders (with
their git history), and `.cortex` of projects that keep it in their repository (a restore leaves those in
`restored-repo-projects/`, for a person to copy back). Left out: search indexes (rebuilt),
`backup.secrets.yaml` (storage keys and the encryption key), projects' local tokens and sessions.

The same from a terminal:

```bash
npx cortexboard hub backup setup --zone my-backups --region ny --key <zone password> --every 24 --keep 14
npx cortexboard hub backup setup --provider gdrive --google-client-id <id> --google-client-secret <secret>
npx cortexboard hub backup connect-google
npx cortexboard hub backup          # now
npx cortexboard hub backup list
npx cortexboard hub restore <file or name> --to <empty folder> --passphrase <key>
npx cortexboard hub set-path <project> <folder>
```

`hub restore` never writes over a running hub: it unpacks into an empty folder. Its `hub/` is a hub
folder (`hub start --dir <folder>/hub`) that keeps the key it was opened with; `repo-projects/<id>/` are
the `.cortex` folders of repository projects.


---

## Optional: search by meaning

Keyword search works out of the box and understands Turkish characters. To also find things by
**meaning** (across languages), run once per machine:

```bash
npx cortexboard semantic on
```

It downloads a local model (~420 MB, once, under `~/.cortex`, shared by every project). Nothing leaves
your machine. `semantic status` shows progress, `semantic off` turns it off.

---

## Upgrading

```bash
npx cortexboard@latest start      # npx: just ask for the new version
npm install -g cortexboard@latest # global install
```

Your `.cortex/` folder is plain files and is read by every version; the search cache rebuilds itself
when its format changes. Read [CHANGELOG.md](../CHANGELOG.md) for what changed. From 0.1 to 0.2 nothing
is needed by hand: an open board is moved to the new sign-in without logging you out, and a line is added
once to `.cortex/.gitattributes` (commit it).

---

## Troubleshooting

| You see | Do |
|---|---|
| `Cortex needs Node.js 22.16 or newer` | Install the current LTS from nodejs.org, open a new terminal. |
| `No .cortex folder found` | Run the command inside the project folder, or pass `--dir <project folder>`. |
| `address already in use` / port taken | `npx cortexboard start --port 4800` |
| The login link says expired | `npx cortexboard login` prints a fresh one (10 minutes). |
| The board opens but says "open the board from the terminal" | Your sign-in ended; use a new login link. |
| The AI tool shows no `cortex_*` tools | Restart the tool after adding the server; check the command runs by hand in the project folder. On Windows try the `cmd /c npx` form. |
| "Stale knowledge" never appears | The project is not a git repository, or the change is not committed yet (only commits count). |
| Hub sign-in does not stick over plain http | Expected: use HTTPS (see [Setup B](#3-run-it-behind-https)). |
| Anything else | `npx cortexboard --version`, then open an issue with what you ran and what you saw. |

---

## Removing Cortex

- Remove the MCP entry from your AI tool (`claude mcp remove cortex`, or delete it from the JSON).
- `npm uninstall -g cortexboard` if you installed it globally.
- `.cortex/` is **your project's knowledge**; delete it only if you really want it gone (it stays in git
  history). `~/.cortex/` holds the optional search model and, on a server, the hub's data.
