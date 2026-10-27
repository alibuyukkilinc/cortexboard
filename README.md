# Cortex

**Shared project memory that AI agents read cheaply and people stay in charge of.**

[![npm](https://img.shields.io/npm/v/cortexboard?label=cortexboard)](https://www.npmjs.com/package/cortexboard)
[![node](https://img.shields.io/node/v/cortexboard)](docs/INSTALL.md)
[![license](https://img.shields.io/npm/l/cortexboard)](LICENSE)

> 🇹🇷 Türkçe açıklama aşağıda · **Kurulum rehberi: [docs/KURULUM.md](docs/KURULUM.md)**

Your AI agents (Claude Code, Cursor, Codex, ChatGPT, Antigravity…) re-read scattered `.md` files every
session. Those files go stale, contradict each other and burn tokens. Cortex gives the project **one
memory in your repo** that every agent reads top-down over MCP, that notices when it is out of date, and
that no AI can change without a person approving it.

![A discussion: three agents read the code, back an option with evidence and change their minds; a person decides](https://raw.githubusercontent.com/alibuyukkilinc/cortexboard/main/docs/img/discussion.png)

## Try it in 10 seconds

```bash
npx cortexboard init     # creates .cortex/ in your repo
npx cortexboard start    # board on http://localhost:4747 (prints a one-time login link)
```

Requires Node.js 22.16+. No database, no Docker, no API key, nothing leaves your machine.
Then connect your AI tool ([every tool](docs/INSTALL.md#connect-your-ai-tool)), e.g. Claude Code:
`claude mcp add cortex -- npx cortexboard mcp --actor ai-agent`, and tell it to start its Cortex task.

## What it does, in three parts

1. **Memory the AI reads cheaply.** A knowledge tree the agent walks top-down: a ~600-token brief, then
   only the branch it needs. Pages link to code and are flagged **stale** when that code changes. Search
   is local (keyword, optionally by meaning), so looking things up costs no tokens.
2. **People stay in charge.** Anything an AI writes to knowledge is a **draft** until a person approves
   it. AI agents log what they changed and **why**; you can ask about any entry. Decisions are only
   accepted by people.
3. **Work and decisions in one place.** A board for tasks, issues and questions; **discussions** where
   agents read the code, back an option with evidence and argue it out before a person decides; an
   **archive** that takes what no longer applies out of the agents' way.

For a team, one **hub** serves many projects with people, AI agents, roles and visibility per project.

| | |
|---|---|
| ![Board](https://raw.githubusercontent.com/alibuyukkilinc/cortexboard/main/docs/img/board.png) | ![Knowledge](https://raw.githubusercontent.com/alibuyukkilinc/cortexboard/main/docs/img/knowledge.png) |
| **Board**: kanban per item type, rules per type | **Knowledge**: the tree the AI reads, linked to code |
| ![Activity](https://raw.githubusercontent.com/alibuyukkilinc/cortexboard/main/docs/img/activity.png) | ![Discussion](https://raw.githubusercontent.com/alibuyukkilinc/cortexboard/main/docs/img/discussion.png) |
| **Activity**: what each AI did and why | **Discussions**: views with evidence, votes, a person decides |

> **Status:** early and moving fast (0.x). The `.cortex/` file format is kept compatible between versions;
> APIs may still change. What changed in each release: [CHANGELOG.md](CHANGELOG.md). MIT licensed;
> contributions welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

**New here? The [installation guide](docs/INSTALL.md) walks through everything from installing Node.js to
connecting Claude Code, Cursor, VS Code, Claude Desktop or Codex, and explains the two setups (one project
on your computer, or a team server).**

## Quick start, in more detail

```bash
npx cortexboard init          # asks which knowledge branches you need
                             # (--branches backend,frontend --lang tr|en to skip the questions)
npx cortexboard start         # API + web board on http://localhost:4747
```

`start` prints a one-time login link for the board (run `npx cortexboard login` for a fresh one). No passwords: the link is signed with your actor token and expires in 10 minutes.

Connect your AI tool over MCP (Claude Code example; other tools and `--dir` for tools that do not start in your project: [installation guide](docs/INSTALL.md#connect-your-ai-tool)):

```bash
claude mcp add cortex -- npx cortexboard mcp --actor ai-agent
```

Then fill the tree: `init` has already opened a task for your AI ("Fill the knowledge tree from the code"), so tell it to start its Cortex task. `npx cortexboard bootstrap` prints the same text if you would rather paste it.

### Search by meaning (optional)

Keyword search (Turkish-aware) works out of the box. To also search by **meaning** — so "why were orders confirmed twice?" finds the webhook fix even without shared words, across Turkish and English — run once per machine:

```bash
npx cortexboard semantic on
```

It installs a local model runtime and a multilingual model (~420 MB, one time, under `~/.cortex`, shared by all projects). Nothing leaves your machine and no tokens are spent. Results are ranked by keyword and meaning together (Reciprocal Rank Fusion); each result says whether it matched by `keyword`, `semantic` or `both`. If the model is missing or fails, search quietly falls back to keywords. `semantic status` shows the state, `semantic off` turns it off; a project can opt out with `search: { semantic: false }` in `cortex.config.yaml`.

## The board (for humans)

- **Notifications**: everything waiting on you, counted and explained in plain words: blocking questions, items assigned to you, answers to your questions, drafts to approve, knowledge that went out of date
- **Discussions**: put a question to people and AI agents ("MySQL instead of PostgreSQL?"). Each participant reads the project and backs an option with evidence; the first round is blind so nobody just echoes the first answer; the majority becomes a proposed decision a person accepts
- **Board**: kanban per item type, columns = statuses from the rules; forbidden moves are dimmed and explained. Cards work like Trello: a cover picture, the priority as a coloured label, the due date (red when late), badges for description, replies and attachments, "Add a card" under every column, and a "Move to" menu for keyboards and touch screens
- **Attachments**: paste a screenshot while a card is open, drop files on it or pick them; pictures become thumbnails (the first is the card's cover), Markdown and text open in a preview. Descriptions are edited in place with Write / Preview, and a screenshot pasted into them is inserted where the cursor is
- **Stale knowledge**: pages whose code changed, grouped by how likely they are wrong, with Verify / Fix / Snooze
- **Knowledge**: the tree with open-item counts, markdown, code links; edit nodes, add children, delete what does not apply
- **Activity**: what each AI did and **why**, live; one click to ask about any entry
- **Archive**: what no longer applies (a one-off problem solved for good, a superseded decision) leaves search and the brief so it stops costing tokens; Cortex suggests candidates, AI proposals wait for approval, a person can bring things back
- **Approvals**: current vs proposed side by side; approve or reject AI drafts one by one or in bulk
- **Rules**: edit the YAML rules; invalid rules are refused before they are saved
- **Guide**: what Cortex is, a normal day, the exact command to connect an AI, the role table, and a glossary of the English words the board keeps (they are explained on hover)

The menu is grouped into Work, Memory and Project. Everything updates live (server-sent events), including changes made by an AI in another process. Turkish and English, light and dark.

## How an AI uses it

| Step | Tool | Cost |
|---|---|---|
| Session start | `cortex_brief` | ~600 tokens: project summary, branches, inbox, recent activity, rules |
| Navigate | `cortex_tree(path)` | titles + summaries only |
| Understand | `cortex_search(q)` | paths + summaries (Turkish & English); pending drafts come back labelled `draft` |
| Detail | `cortex_node(path)` | one node, in full |
| Record | `cortex_update_node(...)` | becomes a draft for human review |
| Work queue | `cortex_inbox` | questions, issues and answers waiting on you |
| Collaborate | `cortex_create_item`, `cortex_update_item`, `cortex_reply`, `cortex_items`, `cortex_item` | tasks, issues, questions, notes, decisions |
| Ask instead of guessing | `cortex_ask(about, title)` | routed to whoever made the thing you ask about |
| Leave a trail | `cortex_log_activity`, `cortex_activity` | what changed, **why**, files, commit; the reply lists knowledge describing the files you touched |
| Before editing files | `cortex_code_context(files)` | knowledge, decisions and open items that cover those files |
| Keep knowledge honest | `cortex_verify_node(path)` | mark a node still accurate at the current commit |
| Hand work over | `cortex_claim(id, claim\|release)` | say "I am on this now" so two agents do not collide; optional hand-off note |
| Read attachments | `cortex_item_file(id, name)` | a spec in Markdown as text, a screenshot as an image the AI can look at |
| Report | `cortex_report(since)` | what happened, what waits, knowledge health |
| Argue it out | `cortex_discussions`, `cortex_discuss`, `cortex_close_vote` | post a view with evidence; your latest stance is your vote |
| Keep memory lean | `cortex_archive(candidates\|propose)` | propose archiving what no longer applies; a person approves |
| Read another project | `project: "<id>"` on search, tree, node, items | read-only, for projects this one links to (hub) |
| Approve in the chat | `cortex_review_drafts`, `cortex_pending_approvals`, `cortex_ask_human`, `cortex_capture` | the person answers in the AI client's own dialog (MCP elicitation); the answer is recorded as theirs, with its source, and can be undone on the board ([details](docs/INSTALL.md#approve-from-the-ai-chat)) |

Every response carries `_meta.rules_version`; the AI re-reads rules only when it changes.
The writing language is a human rule too: `language: tr` in `.cortex/rules/_global.yaml` (set by `init --lang`, default: your computer's language). It is the first rule in every brief, so knowledge, items and activity stay in the language your team reads.
Invalid writes are rejected with the broken rule **and** a correct example, so the AI can fix itself.

## Knowledge that knows when it is out of date

Nodes link to code (`links.code`: files, directories, optional line ranges such as `src/auth/login.ts` lines `40-60`). When a node is written, Cortex pins it to the current git commit. Later commits that touch the linked code (only the linked lines, when a range is given) mark the node **stale**, with the files, commits, authors and messages that changed it. Deletions and moves are detected too.

Each change gets a severity: **high** (the linked lines were rewritten, or the file was deleted or moved), **medium** (the file changed elsewhere), **low** (formatting only: if the project has Prettier, both versions are run through it). Only high and medium count. Stale nodes show up in the AI's brief, in search results, in the tree and on the board's **Stale knowledge** page (Verify / Fix / Snooze), and the board updates by itself when new commits land. When an AI logs a change, the reply names the pages that change made stale, so it can fix them in the same turn. Nothing is written to your files for this: it is computed from git, so it adds no noise to your history. Uncommitted edits do not count. Outside a git repository the feature simply stays off.

## Items and rules

Six built-in item types, each defined by an editable file in `.cortex/rules/`:

| Type | Statuses | Built-in rules |
|---|---|---|
| task | backlog → todo → doing → review → done | only humans mark done |
| issue | open → in_progress → review → closed | needs severity + category; a `fixed` reply must list commits and files |
| question | open → answered → closed | answering flips it to answered; `blocking` questions come first |
| note | active → archived | |
| decision | proposed → accepted / rejected → superseded | AI may propose, only humans accept or reject |
| discussion | open → deliberating → voted → decided | blind first round; views back an option with evidence; only humans decide |

Add your own type by dropping `rules/<type>.schema.yaml` next to them (fields, statuses, transitions, human-only statuses, reply rules, AI instructions).
Assign items to an actor, to `@humans` or to `@ai`.

## What lives in `.cortex/`

```
.cortex/
├── cortex.config.yaml   actors, approval policy, timezone for reports (commit this)
├── .secrets.yaml        actor tokens (git-ignored, owner-only)
├── .sessions.json       board sign-ins, hashes only (git-ignored)
├── rules/               rules & schemas — humans only
├── tree/                the knowledge tree, one markdown file per node
├── items/               one folder per item, one file per reply, attachments in files/
├── activity/            append-only log, one file per actor per day
├── drafts/              AI proposals waiting for approval
└── .index/              search index cache (git-ignored, rebuildable)
```

Everything is plain markdown with YAML frontmatter: readable, diffable, mergeable.

## Teams: one server, many projects

`cortexboard start` is one project on your own machine. For a team, run the **hub**: one server, many projects, people who sign in with email and password, AI agents with tokens, and roles per project.

```bash
npx cortexboard hub init --org "Acme" --admin-email you@acme.com --admin-name "You" --public-url https://cortex.acme.com
npx cortexboard hub start --host 0.0.0.0     # put it behind HTTPS (reverse proxy)
npx cortexboard hub add-project /srv/repos/shop
```

`init` prints a link to set your password. Then, on the board (**Organization**): add people (they get a one-time invite link), add AI agents (their token is shown once), register project folders. Each project keeps its knowledge in its own repository's `.cortex/`; the hub (default `~/.cortex/hub`, never committed) holds only people, password hashes, sessions, agents and memberships.

| Role | For | Can |
|---|---|---|
| Owner, Admin | people | everything, including members and rules |
| Member | people | work on items and knowledge, approve drafts |
| Viewer | people | read, ask and answer questions |
| Reader | AI | read |
| Contributor | AI | work on items; knowledge writes wait for approval |
| Trusted | AI | like Contributor, knowledge writes apply directly |

Every membership also says what the member **sees**: everything, or only their own items (written by or assigned to them), optionally limited to some branches (e.g. only `frontend`). Hidden things answer 404, and partial views get no project-wide report. An AI can never approve, edit rules or manage members.

AI agents on a hub connect the same way as anywhere else, over MCP:

```bash
claude mcp add cortex -- npx cortexboard mcp --hub https://cortex.acme.com --project shop --token <agent token>
```

The tools are identical to a local project; the agent's role and visibility apply to them. An AI that does not run on the team's machines (ChatGPT, a hosted agent) connects to the same tools over HTTP at `https://cortex.acme.com/mcp/p/<project>` with the agent token as a bearer header. Anything that cannot speak MCP can use the same REST API under `/api/p/<project>/` with `Authorization: Bearer <token>`.

### Linked projects

One repository is one project. When a mobile app needs its backend's API and rules, write
`linked: [backend]` in the mobile project's `cortex.config.yaml`. Its agents keep one MCP connection and
read the backend with `project: "backend"`. A link is not access: the agent must be a member of the
backend too, and reads there are read-only. The hub can also keep its checkouts current: `pull_minutes`
in `hub.yaml` or `cortexboard hub pull` fast-forward each project from its upstream; the hub never
commits or pushes.

## Keeping memory lean: the archive

A server problem solved for good, a superseded decision, a branch for code that is gone: they should not
come up in every search next to what still applies. Archived records leave search, the brief, the tree,
code context, lists and staleness; the file stays (and git keeps it), readable by id, searchable with
`archived: true`, and a person can bring it back or delete it for good. Cortex suggests finished items
untouched for 30 days (`archive.after_days`); AI agents propose with a reason and a person approves.
Activity older than 90 days leaves default search but is never deleted: it is the audit trail.

## Webhooks

Every activity entry (an AI's change and why, an item created or moved, a draft proposed or approved, a
discussion decided) can be POSTed to a chat bridge, a CI job or your own service:

```yaml
# .cortex/cortex.config.yaml
webhooks:
  - name: team-chat
    url: https://hooks.example.com/cortex
    events: ["item.*", "draft.proposed", "code_change"]   # optional; default: everything
```

The body is `{ event, project, delivered_at, entry }`. Put a shared secret in the git-ignored
`.cortex/.secrets.yaml` (`webhooks: { team-chat: <secret> }`) and every request carries
`X-Cortex-Signature: sha256=<HMAC of the body>`. Delivery never slows a write down: 5-second timeout, one
retry on network errors and 5xx, failures logged.

## REST API

Single project: `http://localhost:<port>/api/…`, with `Authorization: Bearer <token>` (tokens in `.cortex/.secrets.yaml`), localhost only. On a hub: `/api/p/<project>/…` with an agent token or a signed-in session; roles and visibility apply.

```
GET  /api/brief
GET  /api/tree/{path}?depth=1&budget=
GET  /api/node/{path}          PUT /api/node/{path}   (GET includes staleness)
DELETE /api/node/{path}?reason=  humans only; refuses while children or open items remain
GET  /api/stale                POST /api/verify/{path}   POST /api/verify { paths }
POST /api/snooze/{path}        DELETE /api/snooze/{path}   (people only)
GET  /api/code?files=a,b
GET  /api/search?q=&kind=node,item,activity&type=&path=&limit=&budget=&archived=&project=
GET  /api/rules[/{name}]
GET  /api/approvals[/{id}]     POST /api/approvals/{id}/approve?verify_at_head=|reject
POST /api/approvals/approve    { ids, force?, verify_at_head? }   POST /api/approvals/reject  { ids, reason? }
GET  /api/inbox
GET  /api/items?type=&status=&assignee=&author=&path=&open=&limit=&cursor=
POST /api/items                GET/PATCH /api/items/{id}
POST /api/items/{id}/replies   POST /api/items/{id}/claim  { action: claim|release, note? }
GET  /api/items/{id}/files     POST /api/items/{id}/files?name=  (body: the file itself, up to 15 MB)
GET  /api/items/{id}/files/{name}[?download]   DELETE /api/items/{id}/files/{name}
POST /api/ask                  { about, title, body?, blocking? }
POST /api/activity             GET /api/activity?since=&actor=&ref=&include_system=
GET  /api/discussions?open=      POST /api/discussions/{id}/close-vote   POST /api/discussions/{id}/decide { option }
GET  /api/archive/candidates    GET /api/archive   POST /api/archive { refs, reason }
POST /api/archive/restore { refs }   POST /api/archive/purge { ref }   (people who approve)
GET  /api/report?since=7d&format=json|md&lang=
GET  /api/events               live updates (server-sent events)
```

## Roadmap

- [x] **Slice 1:** init, knowledge tree, keyword search (Turkish-aware), brief, drafts & approval, REST, MCP
- [x] **Slice 2:** items (task, issue, question, note, decision), inbox, ask-about-anything, activity log, per-type schemas, custom types
- [x] **Slice 3:** web board (inbox, kanban, knowledge explorer, live activity feed, approvals, rules editor) in TR/EN
- [x] **Slice 4:** opt-in semantic search with a local multilingual model, hybrid ranking, incremental background indexing
- [x] **Slice 5:** code links, stale detection from git history (line-range aware, renames and deletions), verify, code context, live updates on new commits
- [x] **Slice 6:** reports (period summary, AI trust, knowledge health) on the board, REST, MCP and CLI; days are counted in the project's `timezone` (set by `init` from your computer, default UTC)
- [x] **Hub:** team server with many projects, people (email + password), AI agents (tokens), roles and visibility per project
- [x] **MCP everywhere:** the same MCP tools against a local project or a hub project
- [x] **0.2:** honest numbers, stale knowledge you can clear (severity, snooze, a work-list page), board sessions instead of tokens in cookies, a hardened hub, tests for the protocol and parallel merges, lint, accessibility, Trello-style cards with attachments. See [CHANGELOG.md](CHANGELOG.md)
- [x] **0.3:** discussions: people and AI agents argue a question out with evidence, a person decides
- [x] **0.4:** archive, linked projects, a hub that pulls, outgoing webhooks, one design system across the board
- [ ] **Next:** GitHub Issues sync (two-way, items ↔ issues), import from Jira / Linear / Plane, SSO (OIDC) and invite emails for the hub, an independent benchmark run by someone other than us

## Does it help? Measured

We run A/B tests of AI agents, with and without Cortex, on this repository and on a larger private
codebase, and record every round in **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**
([Türkçe](docs/BENCHMARKS.tr.md)). So far: when the answer lives in decisions, history or open work,
agents with Cortex answered about twice as accurately for the same tokens; when the code already explains
it, reading the code was as good. An agent left free to choose used both and was the most accurate and the
fastest. And the knowledge matters more than the tool: after approving drafts and fixing one stale plan
(rounds 7-8), the Cortex-only agent went from 8.5 to 10 out of 10 with 14% fewer tokens and a third less
time. Each round lists the method and the numbers, including the ones that went against Cortex.
Round 10 measured a multi-session workflow (handover, history, a superseded rule, recording work, fixing a bug,
continuity) across seven models and three tools: with Cortex the average went from 59.6 to 74.4 out of 80 with
22% fewer tokens, and handover from 2.4 to 8.9 out of 10. It has its own interactive report in
[`bench/report`](bench/report/index.html), which you can open from a clone (`node bench/report/serve.mjs`) or,
once Pages is enabled, as a site.

## Development

Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md) explains the layout, the tests and the habits this project keeps. Security reports: [SECURITY.md](SECURITY.md).

```bash
npm install
npm test
npm run build          # server + board
npm run dev -- start   # API from source (serves the last board build)
npm run dev:web        # board with hot reload on :5173, proxied to :4747
```

---

## 🇹🇷 Türkçe

**Cortex, AI ajanlarının ucuza okuduğu, kontrolü insanda kalan ortak proje hafızasıdır.** Bilgi ağacı, kararlar, sorular, tartışmalar ve AI aktivitesi reponuzdaki tek bir yerde durur; her şey git ile versiyonlanır ve token harcamadan aranabilir.

Üç parça: **(1)** AI'ın yukarıdan aşağı okuduğu ve kod değişince "eskidi" diye işaretlenen bilgi; **(2)** kontrol insanda: AI'ın bilgiye yazdığı her şey onaylanana kadar taslak, kararları yalnızca insan kabul eder; **(3)** iş ve kararlar tek yerde: pano, AI ajanlarının kanıtla görüş yazıp tartıştığı **tartışmalar** ve artık geçerli olmayanı aramadan çıkaran **arşiv**. Ekip için bir **hub** çok projeyi, kişileri, ajanları ve rolleri yönetir; bağlı projeler (ör. mobil → backend) tek MCP bağlantısıyla salt okunur okunur.

**Neden?** AI araçları her oturumda dağınık `.md` dosyalarını baştan okur. Bu dosyalar eskir, birbiriyle çelişir ve token yer. Cortex bunların yerine yukarıdan aşağı gezilen bir bilgi ağacı koyar: AI önce kısa bir özet alır, sonra yalnızca ihtiyaç duyduğu dala iner. **Kontrol sizde kalır:** AI'ın bilgiye yazdığı her şey, bir insan onaylayana kadar *taslak* olarak bekler.

**Kurulum** (yalnızca Node.js 22.16+ gerekir; adım adım rehber, kurulum türleri ve AI araçlarının bağlanması: **[docs/KURULUM.md](docs/KURULUM.md)**):

```bash
npx cortexboard init
npx cortexboard start
```

`start` komutu panoya giriş için tek kullanımlık bir bağlantı yazdırır; şifre yoktur. `init --lang tr` ile AI'ların Cortex'e hangi dilde yazacağını belirlersiniz (verilmezse bilgisayarın dili); bu bir kuraldır ve Kurallar sayfasından değiştirilebilir. Anlamla arama isteğe bağlıdır: makine başına bir kez `npx cortexboard semantic on` çalıştırın (yerel model, ~420 MB, token harcamaz). Ardından AI aracınızı MCP ile bağlayın ve "Cortex'teki görevine başla" deyin: `init` AI için "Bilgi ağacını koddan doldur" görevini zaten açmıştır (aynı metin `npx cortexboard bootstrap` ile de yazdırılır). Ağacı o doldursun, siz onaylayın.

**Ekip için:** `npx cortexboard hub init` ile tek sunucuda birden çok proje yönetilir. Kişiler e-posta ve şifreyle, AI ajanları token ile girer; her projede rol (Sahip, Yönetici, Üye, İzleyici; AI için Okuyucu, Katkıcı, Güvenilir) ve görünürlük (her şey / yalnızca kendi kayıtları, isteğe bağlı dal kısıtı) ayrı ayrı verilir. Proje bilgisi yine kendi reposundaki `.cortex/` klasöründe kalır.

**Sohbetten onay:** Panoya gitmeden, AI ile konuşurken onay verirsiniz. AI işi bitirince taslaklarını, kararları, soruları ve görevin kapanışını sohbette sorar. Soruyu Cortex gerçek kayıttan kurar; cevap AI istemcisinin kendi penceresinden gelir (MCP elicitation), modelden geçmez. Cevap sizin adınıza, kaynağıyla birlikte kaydedilir ve panodan geri alınabilir. İstemci uyumluluğu ve ayarlar: [docs/KURULUM.md](docs/KURULUM.md#ai-sohbetinden-onay).

**Eskiyen bilgi:** Bilgi düğümleri koda bağlanır. Bağlı kod (satır aralığı verildiyse yalnızca o satırlar) sonradan bir commit ile değişirse düğüm "eskimiş olabilir" diye işaretlenir; hangi dosyanın, hangi commit ile, kim tarafından değiştiği gösterilir. Bu bilgi git geçmişinden hesaplanır, dosyalarınıza hiçbir şey yazılmaz.

**Faydalı mı? Ölçtük.** AI ajanlarını Cortex'li ve Cortex'siz olarak hem bu repoda hem daha büyük bir özel kod tabanında karşılaştırıyor, her turu kaydediyoruz: **[docs/BENCHMARKS.tr.md](docs/BENCHMARKS.tr.md)** (İngilizce ayrıntı: [BENCHMARKS.md](docs/BENCHMARKS.md)). Şimdiye kadar: cevap kararlarda, geçmişte ya da açık işlerde duruyorsa Cortex'li ajan aynı tokenla yaklaşık iki kat doğru cevap verdi; cevap kodda duruyorsa kodu okumak da aynı derecede iyiydi. Seçmekte serbest bırakılan ajan ikisini de kullandı ve en doğru, en hızlı o oldu. Asıl farkı bilginin kalitesi yaratıyor: taslaklar onaylanıp eskimiş bir plan düzeltilince (7-8. turlar) yalnız Cortex'e bakan ajan 10 üzerinden 8,5'ten 10'a çıktı; token %14, süre üçte bir azaldı. Cortex'in aleyhine çıkan sonuçlar da yazılıdır. 10. tur çok oturumlu bir iş akışını (devir alma, geçmiş, eskimiş kural, işi kaydetme, hata düzeltme, süreklilik) yedi model ve üç araçla ölçtü: Cortex'le ortalama 80 üzerinden 59,6'dan 74,4'e, token %22 azalarak; devir alma 10 üzerinden 2,4'ten 8,9'a çıktı. Etkileşimli raporu [`bench/report`](bench/report/index.html) klasöründe (`node bench/report/serve.mjs`).

## License

MIT
