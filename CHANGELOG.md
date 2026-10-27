# Changelog

All notable changes to `cortexboard`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/) (while it is 0.x, a minor version may change behaviour).

## [Unreleased]

## [0.6.1] - 2026-09-30

### Fixed

- **A backup no longer fails because a connection was already dead.** A request that fails before any answer
  because the other side had closed a reused connection (a reused address can hand one back) is tried once
  more. It failed a whole backup run for no reason; the upload has the same file name, so a retry cannot
  double anything.
- **The voice-typing mic stays inside its field.** It followed the field for 400 ms after focus; a dialog
  whose content arrived later (a slow machine) pushed the field down and left the mic behind. It now follows
  the field every frame while the field has focus, and nothing is redrawn while it stands still.

## [0.6.0] - 2026-09-29

### Added

- **What to try, next to the work waiting for you.** A card waiting for review shows, under its row in
  Notifications, the "to test" list from the reply that handed it in (a "Denemen gerekenler" / "To test"
  heading, else the unchecked boxes); the person ticks the steps as they try them. Work waiting three
  days or more is marked, and the agent that handed it in sees it in its brief (`waiting_on_review`) with
  a nudge to remind the person. The reply tools ask for a short summary first, then that list.
- **Edit part of a knowledge node.** `cortex_update_node` (and `PUT /node`) take `section: "<heading>"`, which
  replaces or adds that heading's part, and `body_mode: "append"`. Title, summary and links left out keep
  their values, so changing one paragraph of a 20 KB node no longer means sending all of it. An AI that
  replaces a body with less than half of it gets `body_shrink` (as with items) unless `confirm_shrink`;
  a node over 8 KB gets a hint to split it into child nodes.
- **`cortex_finish`: finish a piece of work in one call.** It logs the work, replies on the card and moves it
  (through the statuses in between when the rules need them, e.g. an issue from open to review), fills the
  reply fields the type asks for from the commits and files, releases the agent's claim and, if given,
  rewrites the project status. It stops at the first failing step and says what is done and what is left.
- **Approvals for AI tools that connect by URL.** The hub's MCP endpoint (`/mcp/p/<project>`) takes the
  person's chat key in a second header, `X-Cortex-Human-Token`, next to the agent's token. The approval
  tools are then offered, and questions come as questions on the board (a URL connection cannot show
  them in the chat). A key that is not a person's key for that project is refused. The connect guide's
  "Other (URL + header)" setup writes the header when a chat key is added.
- **Questions can offer their answers.** A question takes up to eight `options`; the person picks one in
  the chat, on the board or on the card itself, and may add a note.
- **Connect guide for every AI tool:** Claude Code, Codex (OpenAI), Cursor, Antigravity, opencode and tools
  that connect by URL, each with its own ready setup and a "How to add it" button.
- **A chime** when an AI's question arrives on the board.
- **Questions on the board for clients that cannot ask in the chat.** Some AI clients (Claude desktop,
  Codex, opencode) advertise MCP elicitation but never show the question. Now the same question, built
  from the records, pops up on the board for the person it is meant for; they answer there, from their
  own board session, and the answer is recorded as theirs (`via: board-prompt`).
  - It happens by itself: without elicitation, with `--no-elicitation`, after a refusal too fast to be
    the person's, or when the client never answers.
  - The AI waits 90 seconds, then gets `pending` and a `prompt_id`; the answer still counts when it
    comes. `cortex_ask_human({ prompt_id })` reads it, and `cortex_pending_approvals` lists the AI's
    questions on the board.
  - One question at a time; choosing and sending are two steps, and closing means "later". Put-off
    questions stay one click away and are listed on Approvals; a background tab can notify.
  - Only the person's board session answers: not an API token, a chat key or the MCP server. Questions
    live in `.cortex/.prompts/` (git-ignored, not backed up) and expire after 24 hours; an AI has at most
    five open.
- **Backups, second round.**
  - **Google Drive** next to BunnyCDN: OAuth device sign-in, `drive.file` scope (Cortex sees only its own
    files), a folder found again by name on another machine.
  - **Your own encryption key**, set and changed on the board (12+ characters); a restore can adopt the
    key it was opened with, so a reinstalled hub keeps its old key.
  - **Restore and download from the board.** A hub restore is staged and applied at the next start (the
    hub as it was is kept aside; this machine's address, port and backup settings stay); **Restart the
    hub now** restarts it from the board.
  - **A project's code folder can be changed** (Organization → Projects → Change, `hub set-path`); a
    missing folder is marked.
  - **Backups for a single project without a hub:** a Backups page on its board and `cortexboard backup`
    (`setup`, `list`, `connect-google`, `restore`); a restore replaces `.cortex` in place and keeps the old
    files in `.cortex/.restore/`.
- **Approve from the AI chat.** Drafts, proposed decisions, questions for people and human-only steps
  (a task to done) can be settled in the AI chat instead of on the board.
  - Cortex builds the question from the real record: the draft's diff, the decision's text, the card.
  - The person answers in the client's own dialog (MCP elicitation), so the answer never passes through
    the model.
  - The answer is recorded as theirs, with `via`: channel, the AI that asked, session, and a hash of what
    was shown.
  - New MCP tools: `cortex_pending_approvals`, `cortex_ask_human`, `cortex_review_drafts`,
    `cortex_capture` (save a decision, note or node the person just stated, active at once) and
    `cortex_record_human_answer` (for clients without elicitation).
  - The brief and inbox tell the AI when answers are waiting (`ask_humans`).
- **Relayed answers.** When the client cannot ask, the AI quotes the person's words. `chat.relayed` in
  `cortex.config.yaml` decides what happens:
  - `accept`: applied, marked unverified. The default on a single project.
  - `pending`: waits under Approvals for the person to confirm or discard. The default on a hub.
  - `off`: refused.

  Decisions and human-only statuses need a real answer unless `chat.relayed_human_only` is on.
  `chat.max_batch` caps the drafts asked about in one question (default 10).
- **Answers from the chat on the board.** Replies and activity carry a "from the AI chat" badge. Activity
  has an "Answered in the AI chat" filter (`GET /api/activity?chat=true`), and any such answer can be
  undone:
  - an approved node goes back to its earlier text, or away if it was new;
  - a rejected draft comes back for review;
  - a status goes back, with a reply on the card.

  The undo itself is logged (`POST /api/chat/undo/:entry`).
- **Chat keys on a hub.** A person makes a key for one project on the board (avatar menu). With
  `cortexboard mcp --hub … --human-token <key>`, their answers are recorded as them, with their role.
  Someone whose role could not approve on the board is not asked. A key only reads its project and
  records chat answers.
- **Plan check when handing work in.** An AI moving a task or issue with a written plan to review gets a
  `plan_check` hint to bring the card up to date first. The question asking the person to close it shows
  the plan and the same reminder.
- `cortexboard mcp --human <id>` picks the person approvals are recorded as. `--no-elicitation` is for
  clients that advertise elicitation but do not show it (Codex CLI declines on its own, opencode never
  answers today). A question left unanswered gives up after 10 minutes.
- **Knowledge on the hub, not in the repository.** A project created on a hub keeps its knowledge in
  `~/.cortex/hub/projects/<id>`. Developers' clones carry no `.cortex/` to read stale or edit around the
  hub. The hub commits that folder every minute (`commit_seconds`, 0 = off) and never pushes.
  - `hub add-project --in-repo` (board: `knowledge: "repo"`) keeps the old layout.
  - `hub move-knowledge <project>` moves an existing `<repo>/.cortex` into the hub.
  - Organization → Projects shows where each project's knowledge lives.
- **Decision checks: was a rule skipped?** When an AI logs work with its files, Cortex works out which
  accepted decisions govern them: linked to the files, or filed under the knowledge that links them or a
  branch above it (not the project root). The AI says for each: followed, broken (with the reason) or n/a.
  - `cortex_log_activity` takes `decisions`; `cortex_code_context` lists them beforehand as
    `decisions_to_check`.
  - Nothing is refused for a missing answer. What is left is flagged, the AI's brief reminds it
    (`unanswered_rule_checks`), and it answers later with `cortex_answer_rules`
    (`POST /api/activity/:id/rules`).
  - People see only the exceptions: decisions broken and checks never answered, on Reports, in the
    report's "Decision checks" section and at `GET /api/rule-checks`.
  - At most five decisions are asked about per change (`decision_checks.max_asked`), most specific
    first: linked in code, then the node itself, then under it, then the branches above. The rest come
    back as `decisions_also`. Without the cap this project was asked 15 decisions a change.
- **Security headers on every response.** `Content-Security-Policy` (scripts from this origin only,
  `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`, and HSTS over https. The board can no longer be framed to click approve or delete
  for someone. The theme script moved out of `index.html` into `theme.js` so no inline script is needed.
- **Hub address from the environment.** `CORTEX_PUBLIC_URL`, `CORTEX_TRUST_PROXY` and `CORTEX_ALLOWED_HOSTS`
  win over `hub.yaml` and are never written to it, so a tunnel or domain change is one variable.
- **Backups to BunnyCDN.** Organization → Backups (or `cortexboard hub backup`) sends the hub and every
  project's knowledge to a Bunny storage zone as one archive, always encrypted (AES-256-GCM, a passphrase
  made at setup and shown once). On request, or every `backup.interval_hours`; the newest `keep` stay.
  `hub.db` is copied consistently (`VACUUM INTO`); indexes and machine-local secrets stay out.
  `cortexboard hub restore` unpacks one into an empty folder.
- **Delete people and agents; new tokens from a project.** Organization → People and AI agents have
  Delete: sessions, invites, chat keys and memberships go, what they wrote stays in the projects, and the
  id is retired so it is never handed to someone else. A project's Members page gives an agent a new token
  with the setup guide.
- **Setup guide with the token filled in.** Creating an AI agent (or a new token) now shows how to connect
  it: the command for macOS/Linux, Windows (cmd, PowerShell) or `.mcp.json`, with the hub's address, the
  project and the token already in it, plus how to check it and add a chat key. The hub's address comes
  from `public_url` (`/api/hub/me` → `hub_url`) and can be edited in the dialog. An invite link's dialog
  points to it.
- **Link projects from the board.** Organization → Projects has a "Linked projects" column: pick the
  projects one reads from, and optionally add its AI agents to them as Readers in the same step (a link
  alone gives no access). Saved to the project's `cortex.config.yaml` with its comments kept, and live at
  once (`PUT /api/admin/projects/:id/links`).
- **`review: true` on `cortex_update_node`.** An AI whose knowledge writes apply directly can still send
  one it is unsure of to a person.

### Changed

- **`cortex_code_context` returns only what still applies:** open items and accepted decisions. Finished
  work, closed issues, decided discussions and rejected or superseded decisions become one count
  (`closed_items`); `include_closed: true` lists them.
- **Quieter staleness.** A new `staleness` setting in `cortex.config.yaml` (`all`, `high`, `off`) decides
  which stale knowledge is shown in the brief, board, reports, search and the hint after logged work.
  - The default is `high`: only knowledge whose linked lines were rewritten, or whose file was deleted
    or moved. File-level alerts on busy files were almost all noise (23 of 28 nodes here).
  - Knowledge kept on a hub defaults to `off`.
  - Code links and verified commits are still recorded, so `all` brings everything back.
- **New hub AI agents are Trusted.** Their knowledge writes apply directly; 214 drafts approved and none
  rejected showed the review step was not filtering anything. Adding an existing agent to another project
  still defaults to Contributor. People still approve decisions, rules and answers to questions.
- **Smaller MCP tool list.** `tools/list` goes to the model at the start of every session. The default
  is now a core set of 24 tools (with approvals in the chat) with shorter descriptions: 17.3 KB instead
  of 28.1 KB, about 4,300 tokens instead of 7,000. The rarely used ones (`cortex_items`, `cortex_item_file`,
  `cortex_report`, `cortex_archive`, `cortex_discussions`, `cortex_close_vote`, `cortex_activity`) come
  with `cortexboard mcp --tools full` (env `CORTEX_TOOLS`), or `?tools=full` on the hub's MCP URL.
  `node --import tsx scripts/measure-tools.ts core|full` measures it.
- **`npm test` stops a test after 60 seconds.** A test that left a server open used to hang the whole
  run with no sign of which one it was.

### Fixed

- **A question the client refused on its own no longer reads as the person's no.** Some clients (Claude
  desktop, Codex) decline an approval question without showing it. A refusal faster than 1.5 seconds is
  now marked `suspected_auto_decline`, with a hint to relay the person's words or settle the card on the
  board; after two in one session, the session stops asking through the client, as with
  `--no-elicitation`.
- **Reports no longer count unknown actors as people.** Activity entries now record what their actor
  was (`actor_kind`); an older entry by an actor the config does not know (another client's AI, a
  removed member) is counted as *unknown*, shown on its own in the report, the board and markdown.
- **Pages appear finished, not in pieces.** Each section showed its own skeleton and replaced it when its
  request came back, so a page arrived section by section and everything below kept sliding down. A page
  now waits, hidden, until its first loads are done and then appears at once; a wait longer than 180 ms
  shows one quiet loader (a thin bar and a spinner), a faster one shows nothing. Never hidden for more
  than 8 seconds; live updates and panels opened later are not held back.
- **A project owner could take over an agent shared with other projects.** Resetting an agent's token
  from a project only checked that the agent worked there, but the new token acts in all its projects.
  It now needs someone who manages every one of them (or an organization admin).
- **A card opens over the page it came from.** Creating a card on the board, following a card linked from
  another, or opening one from a notice used to send people to Notifications; closing the card now returns
  to where they were.

## [0.5.0] - 2026-09-28

### Added

- **One queue for what waits on you.** A person's Notifications now lists everything that needs them, in
  the order they act on it:
  1. Finished work to check: tasks and issues an agent or a colleague moved to review. Before this, work
     still assigned to `@ai` never reached anyone's inbox.
  2. Drafts to approve.
  3. Decisions to accept or reject.
  4. Discussions asking for your view.
  5. Your items.
  6. Knowledge that went stale.

  Reviewed work, drafts and decisions can be settled from their row: approve, send back with a note (the
  note goes on the card as a reply), accept or reject. The server builds the queue: it counts it, filters
  it and pages it (`GET /api/inbox?limit&offset`, with `by_reason` counts), so the page makes one request
  and the sidebar badge matches the page. An agent's inbox is unchanged.
- **Live updates say what changed.** Each event on `/api/events` carries a `kind`: `item`, `node`,
  `draft`, `stale`, `log`, … . Every list on the board names the kinds it shows, and only those lists
  reload. When an item changes elsewhere, the inbox makes two requests. A logged entry no longer reloads
  the board or the knowledge tree.
- **Drafts you can actually read.** A draft's text change shows as one column (the default on phones) or
  side by side. Inside a changed line, only the changed words are marked, and long unchanged stretches fold
  away. Changed fields show as a before/after table, not raw JSON. The list shows how much each draft
  changes ("−40 +2"). The draft's reason sits next to its diff.
  - The server works out what a draft changes (`changes` on `/api/approvals/:id`, a size on each row of
    `/api/approvals`, which can now be paged).
  - Worst case, a 500-line page where every line changed, first shows in about 40 ms including the request.
- **Risky drafts are approved one at a time.** A draft is risky when it loses much of what is there: at
  least 5 lines and more than 40% of the page, counted as removed minus added. A risky draft stays out of
  "Select all" and gets no quick approve in the inbox. The server refuses it in a bulk approve
  (`risky_draft`). It can still be approved on its own, after reading.
- Confirmations and reasons are asked in an accessible dialog instead of the browser's `confirm()`/`prompt()`.
- **Item history.** Every change to what an item says (title, text, fields, assignee, branch, tags, links or
  the handoff note) keeps the previous state as a version: the last 20, in the item's own `history/`
  folder, with no git needed. Status moves are not versions, since the replies already record them. The
  drawer's History section shows who changed what, a diff against now, and "Restore this version". A
  restore brings the content back, leaves the status alone, and can itself be undone. API:
  `GET /items/:id/history`, `GET /items/:id/history/:version`, `POST /items/:id/restore`.
- **Forms an agent gets right the first time, and messages beside the field.** The brief's
  `rules.item_types` lists each type with what it must carry, e.g. `issue(category_path,severity)` and
  `decision(context)`, in about as few tokens as the plain list. A rejected write keeps its `issues` lines
  and adds `errors: [{ path, message }]` per field, with field checks named `fields.<name>`.
  - The board's new-item form shows each message beside its field (`aria-invalid`, `aria-describedby`).
  - A decision starts from a template (context, options, decision, consequences) in the board's language.
  - Whether an item is finished comes from the server (`done` in lists), not from "last status" on the board.
- **Stale knowledge, handled from one screen.** A stale node's band now has "Show the code diff": the
  linked files' changes since the node was verified, one patch per file, cut at a size a page can show
  (`GET /api/stale/diff/<path>`).
  - "Ask an agent to update it" opens a task for `@ai` under the node's branch, linked to the node and its
    changed files, with the steps in the project's language, so it lands in an agent's inbox. Asking again
    returns the request already open (`POST /api/stale/request-update/<path>`).
  - On the Stale page, several nodes can be picked and verified together, after a confirmation.
- **Replies you can read, and tasks a person can close from a phone.**
  - Code blocks have a Copy button. Wide tables scroll sideways in a region a keyboard can reach. A long
    reply shows its start and a "Show all" button.
  - An "Acceptance criteria" section (or "Kabul kriterleri") is set apart in its own box.
  - A task reply takes optional `evidence` (commit hashes or links) and `acceptance` (how each criterion
    was met), and the agent instructions ask for both. Projects whose rule files have no reply fields get
    them from the built-in type.
  - A task assigned to a person gets a "Done with it?" panel: the steps are ticked in the text, evidence is
    one link or commit per line, and "I did it" closes the task. If steps are still open, it asks first.
- **Epic progress.** The task boxes in an item's text (`- [ ]`, `- [x]`) are counted on the server: nested
  ones, ordered lists and quotes included, examples inside code blocks left out. Board cards, inbox rows and
  the item drawer show a progress bar ("5/13"). Boxes can be ticked in the drawer
  (`PATCH /items/:id/checklist { line, checked, if_rev }`). Each tick is a version in the item's history,
  and a tick made from an outdated view gets a 409 and a reload instead of undoing someone else's.
  Index version 10: the first open after upgrading rebuilds once.
- **Ids are links.** Item and activity ids in any Markdown on the board link to what they name: a
  discussion opens its own screen, an activity entry opens the feed. Hovering or focusing an id shows a
  preview card. All the ids in a text are previewed with one request (`GET /api/refs?ids=`, up to 100).
  Ids inside code blocks stay text; an inline code span holding just an id is linked.
- **Commits link to GitHub.** Hashes in the activity feed, an issue's `commits` field and the stale-knowledge
  band link to their commit page. The address comes from `project.repo_url` in `cortex.config.yaml`, or
  from git's `origin` when that is on GitHub. With any other remote, hashes stay plain text. An activity
  entry now takes `commits: []` for a change made of several commits, and `commit` still works.
- **Project status.** `.cortex/status.md` holds one short record of where the project stands and what
  comes next: the handoff between sessions and people.
  - The brief carries it, and agents write it with the new `cortex_update_status` tool. It is written
    directly, never as a draft, and the last 20 versions are kept.
  - It counts as stale after 3 days or 20 logged changes (`status: { stale_days, stale_changes }` in
    `cortex.config.yaml`). A stale status is marked in the brief, whose first hint asks for an update, and
    on the board.
  - Notifications opens with the status card, which can be edited in place.
  - API: `GET/PUT /api/status`, `GET /api/status/history`. Members who see only part of a project do
    not get it.
- **Append instead of rewrite.** `update_item` takes `body_mode: "append"` to add to the end of the body. An
  agent that replaces a body of 200+ characters with less than half of it gets `409 body_shrink` unless it
  passes `confirm_shrink: true`. People are asked in a dialog instead.
- **Search filters and saved views.** Board, search and activity keep their filters in the page URL, so a
  filtered page can be bookmarked and shared; saved views are kept per person in `.cortex/views/` (out of
  git). Search takes actor, assignee, since and until, and so do the MCP tools. The board's type tabs keep
  the filters.
- **The week at a glance, epics and milestones.** Tasks and issues take an optional `fields.milestone`.
  Reports open on this week, list epics with their progress, and draw a milestone timeline whose bars
  link to the board filtered by that milestone.
- **Board tabs with an icon per type**, and a badge with how many items of that type wait on you
  (`GET /api/counts` returns `waiting`).
- **Voice typing in every text field**, in Turkish or English, through the browser's own speech
  recognition: a mic in the focused field or Ctrl+Shift+Space, spoken punctuation included. Browsers
  without speech recognition show no button.

### Fixed

- **Two Cortex versions on one project no longer break each other's index.** The index lived in one
  `.cortex/.index/cortex.db` for every version; when two versions ran on the same project (a hub from
  source and an MCP from npm, or a session started before an upgrade), whichever opened last rebuilt the
  tables and the other's writes failed with "table items has N columns but M values were supplied". The
  files were written, but the board, search and inbox fell behind. Each index version now has its own
  file (`cortex-v11.db`), and a new file takes over the embeddings of the older one. Restart running
  Cortex processes after upgrading.
- The board used to load at most 500 items and silently dropped the rest; each column now shows its real
  total and loads more on demand.
- Every screen fits a 375px phone without sideways scrolling, with 44px touch targets.
- Selected rows on the approvals page failed WCAG AA contrast (secondary text on the tinted row).
- On phones, a long branch name arriving after the page could wrap the board's filter bar.
- The count on the active sidebar link failed WCAG AA contrast.
- On phones, the knowledge tree arriving after the page pushed the node below it down.
- On phones, the notifications summary growing to several lines pushed the list down while it loaded.
- Every text on the board was parsed again on each render: the translation function was new every time.

- **Big projects are fast again.** Measured on a seeded project with 1,500 items, 600 nodes and 15,000
  activity entries (Windows, Node 24):
  - The report took 6 s and now takes about 0.12 s. It reads the index instead of every item, reply and
    node file.
  - Opening a project took 5.6 s and now takes 1.4 s. The index stores each file's mtime and size, so an
    open reads only the files that changed while Cortex was closed. Files deleted in that time are found
    by comparing the index with the disk. The first open after upgrading still rebuilds the whole index.
  - Creating an item used to slow down as items piled up (the whole items folder was listed on every
    create, and every write scanned the full search table). Now a create costs about 4 ms however many
    items there are. Parsed rule files are also cached until they change on disk.

## [0.4.0] - 2026-09-25

Memory that stays lean (archive), outgoing webhooks, and three decisions reached in discussions, put to
work: a project reads the projects it links to, the hub keeps its checkouts current by pulling, and the
first round of the design work (the same look, applied with one system on every screen). The README now
says what Cortex is in one screen, with pictures.

### Added

- **Outgoing webhooks.** Every activity entry (an AI's change and why, an item created or moved, a draft
  proposed or approved, a discussion decided) can be POSTed to a chat bridge, a CI job or your own
  service: `webhooks: [{ name, url, events? }]` in `cortex.config.yaml`, where `events` takes action names
  and `item.*` prefixes. A secret in the git-ignored `.secrets.yaml` signs each body
  (`X-Cortex-Signature: sha256=<HMAC>`). The process that writes the entry sends it, so nothing is sent
  twice; a slow or failing endpoint never holds up a write (5 s timeout, one retry on network errors and
  5xx, failures on stderr).

- **Archive: memory that stays lean.** Knowledge and records that no longer apply (a one-off server
  problem solved for good, a superseded decision, a branch for code that is gone) leave search, the
  brief, the tree, code context, item lists and staleness, so they stop crowding out what still applies
  and stop costing tokens. The file stays and git keeps it: an archived record is readable by id or path,
  searchable with `archived: true` ("was this solved before?"), and a person can bring it back or, once
  archived, delete it for good. Cortex suggests candidates (finished items untouched for 30 days that no
  open item cites, knowledge marked deprecated; `archive.after_days` in the project config); only finished
  items can go, never open work or an accepted decision. AI agents propose with `cortex_archive` and a
  reason, which becomes a draft a person approves. Activity older than 90 days (`archive.activity_days`)
  leaves default search but is never archived or deleted: it is the audit trail. New **Archive** page
  under Memory.
- **Linked projects.** A mobile app's agent can read its backend's knowledge through its own MCP
  connection: `linked: [backend]` in the project's config, then `project: "backend"` on `cortex_search`,
  `cortex_tree`, `cortex_node`, `cortex_items` and `cortex_item`. The brief lists the links and whether
  the caller may read them. A link is not access: the caller must be a member of the linked project, whose
  branch and scope limits apply, and linked reads are read-only whatever the role there. Before this an
  agent needed a second MCP entry per project, loading all 23 tools again (decision
  `01M3AM8C6VZ0WB1MA2SMANEQJH`).
- **The hub keeps its checkouts current by pulling.** `pull_minutes` in `hub.yaml` fast-forwards every
  project from its upstream on a timer; `cortexboard hub pull [project]` and **Pull** on Organization →
  Projects do it now. It never commits or pushes: knowledge the hub wrote is counted on the Projects page
  ("3 to commit") until a person commits it, and a diverged branch or a clashing local edit stops the pull
  with the reason instead of being merged or reset (decision `01M3AM8C7QZG19TBK055EJYWXA`).

### Changed

- **One type scale and one spacing scale.** `styles.css` used 14 different font sizes, two of them below
  the 11px floor. Every size is now one of eight `--text-*` steps (11 to 26px), with `--space-1..6` (4px
  steps) for new spacing. Colors that were written out (toasts, diff highlights, board labels, text on a
  colored fill) became theme tokens, so each can differ between light and dark. Breakpoints are down to
  three widths (600 / 860 / 1100px).
- **Loading shows the shape of what is coming.** Pages showed a line of "Loading…"; they now show pulsing
  placeholder rows (still announced as loading to screen readers, still for reduced motion).
- **Empty pages say what to do.** Notifications, Discussions, Search, Activity, Approvals and Stale
  knowledge show an icon, what the emptiness means and, where there is one, the next step (Discussions
  offers "New discussion").
- **The menu is grouped** into Work (notifications, board, discussions, approvals), Memory (knowledge, stale
  knowledge, activity) and Project (reports, rules, members, guide). On a phone it stays one strip.
- **The board's title and its main action sit apart from the filters**, which have a row of their own.
- **Fewer inline styles:** 45 of 142 became shared classes (`.grow`, `.w-auto`, `.text-xs`…); the inline
  font sizes left use the scale.

- **README: what Cortex is, in one screen.** It opened with every feature at once and still said
  "early (v0.2)" while the package was 0.3.0. It now leads with one sentence, a two-command start, three
  parts (memory the AI reads cheaply, people in charge, work and decisions in one place) and screenshots
  of a real board; the version comes from an npm badge instead of being typed in. The roadmap names what
  is next: GitHub Issues sync, Jira/Linear/Plane import, SSO and an independent benchmark.

### Fixed

- **Deciding a discussion for the option the majority proposed accepts that proposal.** It used to reject
  the proposal and create a second, identical decision, leaving a rejected copy next to the accepted one.

## [0.3.0] - 2026-09-24

Discussions: a question put to people and AI agents together, argued out on its own screen and settled
by a person, with the views and votes kept next to the decision they produced.

### Added

- **Discussions.** A question put to people and AI agents together ("MySQL instead of PostgreSQL?"), on its
  own screen next to the board. The one who opens it lists 2 to 8 options and who is invited; each
  participant reads the project and posts a view that backs one option, with a confidence and evidence
  (`file:lines`, a knowledge path, an item). The first round is blind by default: a participant sees the
  others' views only after posting, so an agent does not just repeat the first answer it reads; blind views
  also stay out of search and list previews. Once the views are opened, participants answer each other and a
  new stance changes their vote. Counting the votes turns a clear majority into a proposed decision whose
  alternatives are filled from the views; a person accepts it, or picks another option, and the discussion
  is decided. It is an item type (`discussion`) with views as replies, so it lives in git like the rest.
  New MCP tools: `cortex_discussions`, `cortex_discuss`, `cortex_close_vote`; invited agents find open
  discussions in `cortex_inbox`. REST: `GET /discussions`, `POST /discussions/:id/close-vote`,
  `POST /discussions/:id/decide` (people only).

### Changed

- **The hub's own screens use the window.** Projects, Organization and Usage sat in a 1080px column,
  a narrow strip next to a project board that fills the screen. They now take the width they are given
  (up to 1900px) with the board's side padding; paragraphs keep their own reading measure.

## [0.2.4] - 2026-09-24

Connecting an AI agent to a team server, without the board getting in the way: access can be granted from
a terminal, a refusal says who was refused, and the board stops re-reading lists it only wanted to count.

### Fixed

- **The install smoke test measures two things apart.** It failed a release on a Windows CI runner for
  being 3 seconds over two minutes, almost all of it `npm install` downloading. Cortex's own init + start
  now has its own budget (45 s, not adjustable); the whole-run limit stays 120 s on a developer machine
  and is raised in CI through `SMOKE_LIMIT_MS`, where the download is the runner's, not ours. Measured
  here: 15.7 s total, 6.5 s of it Cortex.
- **Two records written in the same millisecond keep their order.** Ids are ULIDs, but the random part was
  redrawn on every call, so entries sharing a millisecond sorted at random: a report's "newest first" came
  out differently on different machines, and CI caught it on one leg of the matrix. The random part is now
  incremented inside a millisecond, the way the ULID spec describes.

### Added

- **`cortexboard hub member <project> <who>`** gives a person or an AI agent access to a project from the
  machine that runs the hub, with `--role`, `--scope`, `--branches` and `--remove`. Until now the only way
  to grant an agent a project was the board, which left a working token failing with "not a member" and
  no way to fix it from a terminal. A membership granted this way is live on the next request: the row
  decides access, and the project's actor list catches up in the same moment, so no restart is needed.

### Changed

- **A refusal names who was refused and where.** `You are not a member of this project.` became
  `opencode is not a member of "app-api".`: an agent's error is read in someone else's log, where
  "this project" means nothing. The MCP endpoint already said it this way.

### Fixed

- **The MCP server announces the version it ships as.** Its `serverInfo` was pinned to `0.1.0` in the
  code, so every client (and every MCP log) saw the wrong number. The CLI's `--version` and the MCP
  handshake now read the same `package.json`.

### Performance

- **The sidebar badges cost one small request.** The three numbers next to Notifications, Approvals and
  Stale knowledge were fed by three separate requests, two of which pulled a whole list only to count it,
  on every live event and from whatever page was open. `GET /counts` now answers all three, with the same
  visibility rules. Measured with 14 pending drafts: **5,856 bytes over 3 requests → 75 bytes in 1** (-99%).
  On a real week, `/approvals` alone was 5.2 MB of 8.7 MB of board traffic.

## [0.2.3] - 2026-09-24

A board that stays usable when it fills up, and a bootstrap task that cannot leak what git hides.

### Security

- **The bootstrap task no longer lists files git ignores.** The markdown it asks the AI to import came
  from a plain folder walk, so a git-ignored `docs/ai/infra.local.md` holding real server keys was listed
  on a real project, and anything imported lands in the committed `.cortex/`. In a git repository the
  list now comes from `git ls-files` (tracked, and untracked but not ignored); outside git, `*.local.md`
  is skipped. The task text also tells the AI never to copy secrets into Cortex.

### Fixed

- **A full board column scrolls again.** Cards are flex children, so a column that ran out of room
  squeezed them instead of showing a scrollbar: ten cards were flattened into the height of three, with
  their text clipped. Cards keep their own height now, and the board page fills the window, so every
  column caps itself against the visible area, scrolls inside, and keeps "Add a card" at the bottom.
- **Moving an item no longer needs a sentence.** Under the reply box, picking a status with nothing
  written moves the item (the same request a board card makes) instead of leaving the button disabled.
  The button says which move it will make.
- **Large docs folders are listed whole.** The markdown list stopped at 50 files, so a disaster-recovery
  runbook was left out on a project with 51; the limit is now 200.
- **`init --agent-files` adds the hint once.** A `CLAUDE.md` that only imports `AGENTS.md` (`@AGENTS.md`)
  is left alone; the hint goes to `AGENTS.md`, instead of Claude reading it twice.

### Changed

- **Text is slightly smaller** everywhere on the board: the base size goes from 14px to 13.5px and each
  step of the scale follows it down, with the smallest labels left at 11px.

## [0.2.2] - 2026-09-24

For a team setting up a project that never used Cortex, and for agents that read the queue: the first
AI finds its task, reading open work takes fewer calls, and keyword search reaches other forms of a word.

### Added

- **A new project tells its first AI what to do.** `init` (also `hub add-project --init` and "Add project"
  on the hub) opens a task for `@ai`, "Fill the knowledge tree from the code (first setup)", with the
  bootstrap instructions as its body, in the project's language. Until the root summary is written, the
  brief's `next` holds only that step. An agent connecting through a hub used to find an empty tree and
  no instructions; now it finds the task in its inbox. `cortexboard bootstrap` still prints the text.
- **`hub add-project --init --branches a,b`** (and `branches` on `POST /api/admin/projects`): pick the
  top-level branches when registering a new project on the hub, as `init --branches` does.
- **Fewer calls to read the queue.** `cortex_items(preview: true)` (REST `GET /items?preview=true`) adds a
  short gist of each item's body and its last reply (who, when, which status change) to every row, and
  `cortex_item` takes `ids` to read up to 10 related items in one call; a missing or hidden one only fails
  its own row. The brief gains `open_elsewhere`: open work waiting on someone other than you, never
  repeating the inbox and left out when empty. In an A/B run agents answered the same five questions with
  12 tool calls instead of 20, 19% faster, at the same accuracy.

### Fixed

- **Keyword search finds other forms of a word.** When no record has every word as written, search
  tries each word's stem too ("ertelemek" finds "erteleme" and "ertelenebilir"), and records matching
  any word fill the rest of the page as before. Exact matches are never displaced: stems are only the
  fallback, and words of five letters or fewer are never cut.
- **A Turkish project no longer opens on an English tree.** `init --lang tr` now seeds the branch
  titles and summaries, and the root node's placeholder, in Turkish; a language with no seed still
  gets English, and the bootstrap task rewrites all of it anyway. Reports keep counting a seeded
  branch as undocumented in every language (the check reads the seed table, not one hard-coded phrase).

## [0.2.1] - 2026-09-24

### Changed

- **One command: `cortexboard`.** The short `cortex` alias is gone; it was a name common enough to
  collide with another tool in a global install. Every example, message and document uses the full name.

## [0.2.0] - 2026-09-24

The theme of this release is making what 0.1 already had trustworthy: honest numbers, stale knowledge
you can clear, a board session that is not an API key, a hub that is safe to invite people to, and tests
for the parts that had none. Every entry below comes from one commit, and says what changed and, where it
was measured, by how much.

### Changed

- **Accepted decisions no longer count as open work.** They were settled but kept showing up in open-item
  counts, branch counters, the inbox and reports. A schema can now mark statuses as `resolved`
  (decisions: `accepted`); `accepted → superseded` stays allowed. On this repository: open items 19 → 6,
  the backend branch counter 15 → 3.
- **The report's activity headline counts logged work, not the audit trail.** `totals.activity` is now
  `{ logged, system }`; audit entries are a context series on the chart, so they no longer flatten the
  real work into the axis. On this repository (30 days): 328 → 20 logged entries, plus 308 audit entries.
- **Staleness has severity.** High (the linked lines were rewritten, or the file was deleted or moved),
  medium (the file changed elsewhere), low (formatting only). Only high and medium count in the brief,
  the inbox, the tree and the menu.
- **Formatting sweeps are recognised as formatting.** If the project has Prettier, both versions of a
  changed file are formatted with the project's own config and compared, in one child process; the verdict
  is kept per file-content pair in `.cortex/.index/`. Measured on this repository's own formatting sweep:
  22 of 22 affected nodes are low (they were all medium or high with a whitespace-only check).
- **Knowledge approved from a draft is pinned to the current commit** when its linked files did not change
  since the draft was proposed. Before, every approved draft kept the commit it was proposed at and could
  be stale on arrival. If the files did change, the old pin stays and the approval returns
  `stale_after_approval`; the approver can choose "verify at HEAD".
- **Hub invites live 48 hours**, not 7 days.
- **Hub session cookie `Secure` flag**: an explicit `cookie_secure` setting wins; otherwise it is on unless
  the hub listens on loopback only. With `trust_proxy: true`, an `X-Forwarded-Proto: https` request also
  gets it. It used to be guessed from `public_url`, which missed hubs reached over plain LAN addresses.
- **Hub `allowed_hosts` is the whole list**: the silent `localhost`/`127.0.0.1` exception is gone (behind a
  proxy, any request can claim it). Add `localhost` to the list if you want it.

### Added

- **Stale knowledge page** on the board: grouped by severity, with Verify / Fix / Snooze on every row and
  "verify all formatting-only". Snoozes are for people only, live in `.cortex/.index/` (never in git), and
  lift themselves when the same files change again.
- **`cortex_log_activity` names the knowledge your change made stale** and asks the AI to update or verify
  it in the same turn (still a draft a person approves). The brief lists them under
  `stale_nodes.from_your_changes`.
- **`cortexboard logout [--actor <id>] [--all]`** ends board sessions, also on a running server.
- **Board**: a "Move to" menu on every card (keyboards and touch screens), announced to screen readers.
- **Lint and format**: `npm run lint` (oxlint with type information: floating and misused promises,
  `await` on non-promises, type-only imports, React hooks rules, and four jsx-a11y rules) and
  `npm run format:check` (Prettier). Both run in CI.
- **Attachments on items, Trello-style.** Paste a screenshot anywhere while a card is open (or in the
  new-item dialog), drop files on it, or pick them. Files live next to the item in
  `.cortex/items/<id>-<slug>/files/` (versioned in git; a file put there by hand is attached too), up to
  15 MB each. Pictures show as thumbnails and the first becomes the card's cover; Markdown and text open
  in a preview. `files/<name>` in Markdown points at an attachment of the same item, and pasting into a
  description or reply inserts that reference at the cursor. REST: `GET|POST /items/:id/files`,
  `GET|DELETE /items/:id/files/:name`. Anything that could run in the page (SVG, HTML, PDF) is served as a
  download, never inline.
- **`cortex_item_file` (MCP):** an AI reads an attached spec as text and a screenshot as an image.
- **Board cards:** the priority (or severity) as a coloured label, the due date (red when late), badges
  for description, replies and attachments, and "Add a card" at the bottom of every column.
- **Descriptions are edited in place** on the card, with Write / Preview tabs.
- **Installation guide** for people new to all of it, in English and Turkish ([docs/INSTALL.md](docs/INSTALL.md),
  [docs/KURULUM.md](docs/KURULUM.md)): what to install, the two setups and how they differ, connecting
  Claude Code, Cursor, VS Code, Claude Desktop and Codex, running a hub behind HTTPS, upgrading and
  troubleshooting.
- **`--dir <project folder>`** (or `CORTEX_DIR`) on every project command, for MCP clients that do not start
  servers in the project folder (Claude Desktop, Codex). `init --dir` creates the project there.
- **`cortexboard --version`**.
- **Tests** for the CLI, git, frontmatter, agent files, the full AI protocol over MCP, a two-clone
  parallel merge and attachments. 89 → 137 tests.

### Fixed

- **Parallel work no longer conflicts in the activity log.** The same actor writing on two machines on the
  same day (one AI id on two laptops) produced an add/add conflict on every merge.
  `.cortex/.gitattributes` now merges `activity/**/*.jsonl` by union; existing projects get the line added
  the first time Cortex opens them.
- **Code-linked files with non-ASCII names were never reported stale** (for example `src/ödeme.ts`): git
  printed them quoted and escaped. Git now runs with `core.quotepath=false`, and paths are compared in NFC,
  so decomposed macOS names match too.
- **An AI that logs its change right after committing** now sees what that commit made stale (staleness was
  throttled for 3 s and still saw the old HEAD).
- **Members who see part of a project got short pages and a wrong total** (visibility was filtered after
  `LIMIT`). It is now part of the SQL query. 60 items, member sees 24, `limit=10`: pages of 10, 10, 4 and a
  total of 24.
- **Two async form handlers** in the hub screens were passed where a void handler was expected (found by
  the new lint rules).
- Escape closed every open window at once (a preview opened from a card took the card with it); it now
  closes only the top one.

### Security

- **The board cookie is a session, not the API token.** A copied cookie used to be a copied API key, and
  logging out ended nothing. Sessions are random keys stored only as SHA-256 hashes in
  `.cortex/.sessions.json` (owner-only, git-ignored), valid 30 days, revocable. A cookie that still holds
  a raw token is accepted once and swapped for a session, so nobody is logged out by the upgrade.
- **`.secrets.yaml` is owner-only (0600)**; an older, looser file is tightened on first read (POSIX).
- **Token checks** no longer read the secrets file on every request (cached by mtime) and compare hashes in
  constant time over every entry: 763 µs → 31 µs per request.
- **Hub rate limits on every door**: 10 wrong passwords per address and email, 10 bad agent tokens per
  address (REST and MCP together), 20 dead invite links per address, per 15 minutes. The limiter's memory
  is bounded.
- **At most 50 live board streams per project** (`CORTEX_SSE_LIMIT`), then `503` with `Retry-After`.

### Performance

- Looking up items no longer lists the whole items folder on every miss: reading 2,000 items went from
  5.1 s to 2.0 s (it was quadratic, now linear).
- Staleness asks git once per HEAD: writes that force a recompute at the same HEAD re-ask git nothing.

### Known limitations

- The hub keeps every project it has opened in memory until it restarts. That only matters for a hosted
  hub with more projects than memory; there is none today, and evicting a project under an in-flight
  request is riskier than the leak.
- The first staleness check after new code arrives can take a few seconds on Windows (every git call
  starts a process, ~45 ms each); later checks at the same commit are cached.
- The raw-token board cookie is accepted once for the upgrade; this compatibility path will be removed
  after 0.2.x.

## 0.1.0 - 2026-09-22 (never published)

First version: knowledge tree, items and rules, the web board, optional semantic search, git-based
staleness, reports, the team server (hub) with roles, and MCP tools for AIs.

[Unreleased]: https://github.com/alibuyukkilinc/cortexboard/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.6.1
[0.6.0]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.6.0
[0.5.0]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.5.0
[0.4.0]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.4.0
[0.3.0]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.3.0
[0.2.4]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.2.4
[0.2.3]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.2.3
[0.2.2]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.2.2
[0.2.1]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.2.1
[0.2.0]: https://github.com/alibuyukkilinc/cortexboard/releases/tag/v0.2.0
