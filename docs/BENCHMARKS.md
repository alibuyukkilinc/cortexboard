# Benchmarks: does Cortex help an AI agent?

These are A/B runs of AI coding agents. Rounds 1-5 run on this repository, which runs on its own Cortex
knowledge (`.cortex/`); round 6 runs on a larger private codebase with a weaker model; rounds 7-8 run on
that same private codebase with Claude sub-agents and a third, unguided group. Türkçe özet:
[BENCHMARKS.tr.md](BENCHMARKS.tr.md). Each run is
recorded as it happened, so later changes can be measured against it. Numbers are not polished: where a
result went against Cortex, it is written down as such.

## How a run works

- **Agents.** Claude Code sub-agents (same model, same prompt apart from the tool rules), started in
  parallel on the same commit.
- **Control (A, "no Cortex").** May read everything in the repo (code, tests, README, CHANGELOG,
  CORTEX_SPEC.md, git history) except `.cortex/`, and may not call the Cortex MCP tools.
- **Cortex (B).** Starts with `cortex_brief`, then uses the Cortex MCP tools; may read code to confirm.
  May not read `.cortex/` files directly (only through the tools). Read-only: writes nothing.
- **Grading.** Before the agents run, the answer key is taken from Cortex and the code. Each answer is
  scored 0–1 (partial credit for partly right; "not found" is 0, a wrong claim is 0).
- **Measured.** Tokens and wall time as reported by the agent runtime (`subagent_tokens`,
  `duration_ms`), and tool calls. Tokens include each agent's fixed start-up context (system prompt, tool
  definitions), which is the same for both groups and is a large share of every total.
- **Repository size at the time:** about 8.3k lines in `src/`, 20k with tests and the web board, 94 files
  in `.cortex/`. Small, and well commented: a good case for the control group.

## Results at a glance

| Round | Date | Question type | Agents | Accuracy A → B | Tokens A → B | Calls A → B | Time A → B |
|---|---|---|---|---|---|---|---|
| 1 | 2026-09-24 | 5 facts that are also in code/CHANGELOG | 1+1 | 4.75 → **5.0** | **63.1K** → 67.1K | 9 → 13 | 39 s → **26 s** |
| 2 | 2026-09-24 | 5 "why / who decided / what is open" | 3+3 | 2.5 → **4.9** | **62.5K** → 68.3K | 7 → 20 | 41 s → 43 s |
| 3 | 2026-09-24 | Round 2 again, after tool changes (`be7ccd7`) | 3 (B only) | 2.5 → **4.97** | **62.5K** → 69.4K | 7 → 12 | 41 s → **35 s** |
| 4 | 2026-09-24 | One large design task (outgoing webhooks) | 3+3 | 11.5 → 11.6 / 12 | **88.1K** → 90.1K | 9 → 27 | **82 s** → 91 s |
| 5 | 2026-09-24 | Search only: keyword vs. hybrid (semantic on) | 2+2 | 6 → 6 / 6 | 68.2K → 66.3K | 11.5 → 11 | 19 s → 19 s |
| 6 | 2026-09-24 | One real question on a larger codebase, weaker model | 1+1 | 14.5 → **23.5** / 26 | 55.5K* → **3.9K** | 8 files → 7 | — |
| 7 | 2026-09-28 | 5 "what" + 5 "why" questions, larger private codebase, 3 groups | 2+2 (+2 free) | 8.25 → 8.5 / 10 | 198.3K → **184.9K** | 49 → 34 | 165 s → **111 s** |
| 8 | 2026-09-28 | Round 7 again after fixing the knowledge (drafts, stale plan, memory) | 2+2 (+2 free) | 8.75 → **10** / 10 | 196.1K → **158.1K** | 44 → 17 | 173 s → **73 s** |
| 9 | 2026-09-29 | 5 "what" + 5 "why" on this repo's newest changes, two model sizes | 1+1 (+1 free, +2 Haiku) | 7.0 → **9.25** / 10 | **77.0K** → 81.8K | 24 → 12 | 63 s → **49 s** |
| 10 | 2026-09-30 | 8-task multi-session workflow (handover, history, current rule, writing, bug fix, continuity), 3 Claude + GPT + 3 OpenCode models | 7 models × 2 arms | 59.6 → **74.4** / 80 | 3,563K → **2,780K** | 147 → 112 | 22.7 min → **18.7 min** |

\* Round 6 measures retrieved context, not an agent's whole budget: the bytes Cortex served, against the
size of the files the control run cited. Not the same unit as rounds 1-5 (see the round).

Accuracy per 1K tokens, rounds 2–3: A 0.040, B 0.072 (+80%); in other words about 24.7K tokens per
correct answer without Cortex and 14.0K with it.

## Round 1: facts that also live in the code

Questions: why oxlint instead of typescript-eslint (and the decision id), Turkish file names and git on
macOS, why an approved draft is stale right away, the brief's token limit, the minimum Node version.

- Both groups answered almost everything. The control found the reasons in commit messages and the
  CHANGELOG, which in this repo repeat much of what Cortex holds.
- Only Cortex returned the decision id, its status ("proposed") and the rejected alternatives, and it
  noticed that an older decision still said "Node 22.13+" (out of date).
- **Takeaway:** when the code and changelog already say it, Cortex is faster (−33%) but not cheaper.

## Round 2: knowledge that is not in the code

Questions: which timezone reports use *and who decided it*; how a mobile team joins (the decision and
whether it is final); what work is open and on whom; what to keep consistent before editing
`src/git/git.ts` and what to update afterwards; why Cortex never calls an LLM and which alternatives were
weighed.

| Question | A | B |
|---|---|---|
| Timezone, who decided, what triggered it | 0.6 | 1 |
| Mobile team decision | 0.4 | 1 |
| Open work and who it waits on | **0.1** | 1 |
| Before editing `git.ts` | 0.8 | 0.95 |
| No LLM: reasons, alternatives | 0.65 | 1 |

- The control said "not found" for decisions, open items and alternatives, which was honest. Two
  control agents also flagged an already-closed item as "outdated": a wrong claim made from indirect
  evidence (the git status).
- The Cortex agents found four stale records in Cortex itself (a publish task still in backlog after
  0.2.1 shipped, a decision whose text still said "proposal", an answered question never closed).
- **Cost:** about 20 tool calls per Cortex agent. They listed items, then opened them one by one.

## Round 3: fewer calls (commit `be7ccd7`)

Changes made from round 2's traces:

- `cortex_items(preview: true)`: each row carries a short gist of the body and the last reply.
- `cortex_item(ids: [...])`: up to 10 related items in one call.
- The brief lists open work waiting on others (`open_elsewhere`), never repeating the inbox.

Same prompt, same questions, three new Cortex agents: **20 → 12 tool calls, 43 s → 35 s, accuracy
4.9 → 4.97**. Total tokens did not move (68.3K → 69.4K): the same content is read, in fewer and larger
responses. Fewer round trips still matter in practice, because every turn re-processes the context.

## Round 4: one large task that needs a feel for the whole system

Task: write the implementation plan for outgoing webhooks (item created or status changed, reply,
draft proposed or approved, node became stale), in single-project mode and on the hub. Graded against
12 points, among them:

- hook into the audit trail (`ActivityService.system`), not into REST routes;
- **the two-process trap:** `cortexboard mcp` writes from its own process, so the board server only sees
  a bare `reindex`; dispatch needs a persisted cursor, not the in-memory event;
- no replay on `git pull` or `reindex`;
- secrets in `.secrets.yaml` or `hub.db`, never in the committed `cortex.config.yaml`;
- humans only (no AI role, no MCP tool); restricted members and visibility on the hub;
- lazily opened hub projects; draft semantics; `item.updated` counts as a status change only when
  `from !== to`; HMAC, retries, SSRF guard; tests and what else to update.

| | A (no Cortex) | B (Cortex) |
|---|---|---|
| Score (of 12) | 11.5 | 11.6 |
| Tokens | **88.1K** | 90.1K |
| Tool calls | **9** | 27 |
| Time | **82 s** | 91 s |

- **All six plans were strong,** and all six found the two-process trap. In a codebase this size, with
  this many code comments, an agent that reads the core files gets the architecture right.
- Only the Cortex agents named the exact knowledge nodes to update and recalled project gotchas
  (no `console.log` on the MCP path, no numbered `node:sqlite` parameters, the 800-token brief). Only the
  control agents noticed that `SECURITY.md` says Cortex "never sends project data anywhere", a line
  webhooks make false.
- The Cortex agents did both: read Cortex *and* the same code. That is where the extra calls went.
- **Takeaway:** the "deeper context" hypothesis did not show up at this size. Cortex's edge here is
  decisions, history and open work (round 2), not architecture that the code already explains.

## Round 5: semantic search

Six questions worded in English with no words in common with the Turkish knowledge (for example "What
stops a copied browser cookie from being as powerful as an API key?", "Can someone temporarily postpone
dealing with outdated knowledge?").

**Keyword search (FTS5), the default:**

- Direct hit rate, the English question as the query, right record in the top 3: **2 of 6**. The misses
  still returned five plausible-looking but wrong results.
- Agents limited to `cortex_search` (then opening what it returned): **6 of 6 correct**, 6 searches,
  66–70K tokens, 19 s. The agents rewrote the queries in Turkish and found everything.

**Hybrid search** (`cortexboard semantic on`: local `paraphrase-multilingual-MiniLM-L12-v2`, fused with
keyword results by RRF), same six questions:

- Agents limited to search: **6 of 6 again**, 6 searches, 66–67K tokens, 18–19 s. No measurable gain.
- Rank of the right record in the top 10, by query language (a dash means not in the top 10):

| Question | EN keyword | EN semantic only | EN hybrid | TR keyword | TR semantic only | TR hybrid |
|---|---|---|---|---|---|---|
| Late-night work, previous day | – | **1** | 2 | 1 | 1 | 1 |
| Copied cookie vs. API key | 6 | – | 6 | 1 | 3 | 1 |
| Linter vs. new compiler | 3 | – | 5 | 1 | 1 | 1 |
| Accented file names on macOS | – | – | – | 3 | – | 5 |
| Half-empty pages for restricted members | **1** | 2 | **–** | 1 | 1 | 1 |
| Postponing outdated knowledge | – | – | – | – | – | – |
| **Found in top 10** | 3 | 2 | 3 | 5 | 4 | 5 |

What this shows:

- **Semantic search helped once:** the English "late-night work" question, which shares no words with the
  Turkish record, went from not found to rank 1 (rank 2 in hybrid).
- **Hybrid also lost a hit.** Keyword search ranked the "half-empty pages" answer first, and hybrid
  dropped it out of the top 10. With RRF, a record that only one list finds scores 1/61, and ten mediocre
  records that both lists find weakly (common words, loose similarity) all score higher. A strong hit
  from one list should not vanish.
- **Turkish word forms defeat both.** "ertelemek" (to postpone) does not match "erteleme" or
  "ertelenebilir" in the keyword index (no stemming), and the semantic vector of a long node, cut at
  2,000 characters, is too diluted to rank the one line about snoozing.
- **Agents do not depend on either.** They rewrote English questions into Turkish project vocabulary
  and got 6 of 6 either way. For an AI caller, the search mode matters less than it seems; for a person
  typing into the board's search box, it matters more.

### Follow-up: keyword stems (semantic search set aside)

Semantic search was turned off again: it added a 420 MB download for no measured gain. Keyword search
got the one fix the round pointed at: when no record has every word as written, each word's stem is
tried too (at most three letters dropped, never below five). Measured on 20 queries (the 12 above plus
8 more in both languages), rank of the right record in the top 10:

| | Before | After |
|---|---|---|
| Found in top 10 | 17 / 20 | **18 / 20** |
| At rank 1 | 11 | 11 |
| Worse by one rank | | 1 ("onaylanan taslak…": 7 → 8) |
| Newly found | | "eskimiş bilgiyi ertelemek": – → 3 |

Using stems from the start, or in the "any word" fallback, was tried first and measured worse (it
widened matches that were already right), so stems are only a middle step.

## Round 6: a larger codebase, a weaker model, one real question

The open question from "next runs": what happens on a bigger, less commented codebase, where reading the
code costs more. Run on a private product backend (NestJS + Prisma, a marketplace with listings, EAV
attributes and a map), not on this repository, and with a small free-tier model instead of the Claude
sub-agents of rounds 1-5.

- **Question** (one sentence, identical in both runs, the way a developer would ask it): how to add a
  boolean filter to listings, sort the results by price per square metre and show them on the map.
- **Control (A).** That repository, full filesystem access, no Cortex.
- **Cortex (B).** The same repository *and* Cortex over the hub (MCP), so every call is metered in bytes.
- **Answer key:** 10 items, weighted, 26 points. Half are in the code, half only in Cortex (decisions,
  rules, traps). Every code-level claim in both answers was verified against the source.

| | A (no Cortex) | B (Cortex) |
|---|---|---|
| Accuracy | 14.5 / 26 (56%) | **23.5 / 26 (90%)** |
| Retrieved context | 8 files cited, 222 KB ≈ 55.5K tokens if read whole | **7 calls, 15.8 KB ≈ 3.9K tokens** |
| Per correct point | ≈ 1,276 tokens (at a third of that read) | **≈ 168 tokens** |
| Wrong claims | none | none |
| Against a recorded decision | **yes** | no |

```
Accuracy (of 26)        0         7        14       21   26
  A  no Cortex          ██████████████░░░░░░░░░░░░  14.5
  B  Cortex             ███████████████████████░░░  23.5

Retrieved context (tokens; A is an upper bound)
  A  8 files, 222 KB    ████████████████████████████████████  55.5K
  B  7 calls, 15.8 KB   ██▌                                     3.9K

Tokens per correct point
  A                     ████████████████████████████████████  ~1,276
  B                     ████▊                                     ~168
```

Item by item (● = weight):

| Item | Where the answer lives | A | B |
|---|---|---|---|
| ●●● Features are EAV rows, not new columns | decision only | ✗ recommends the rejected option | ✓ |
| ●●●● A new filter goes in four places or it is silently dropped on one path | four functions, far apart | ◐ two of four | ✓ |
| ●● Add it to the DTO whitelist or the request 400s | code | ✓ | ✓ |
| ●●● Denormalised price column: field priority, NULLS LAST, backfill script | code + rule | ◐ no backfill | ✓ |
| ●●● Map endpoints, clustering thresholds, 60 s cache | code | ✓ | ✓ |
| ●● Haversine and a bbox, deliberately not PostGIS | decision only | ✗ | ✓ |
| ●●●● Globally cached endpoints apply visibility regardless of role | code + rule | ✓ | ✓ |
| ●● The list endpoint returns no coordinates (mobile contract) | contract only | ✗ | ✓ |
| ●● Every query needs the tenant filter | decision only | ✗ | ✗ |
| ● Cache is cleared by an event, not by TTL alone | code | ◐ | ◐ |

What the numbers do not show, and matters more than them:

- **The control's answer was not wrong; it was against the architecture.** It recommended adding a column
  and a migration as "the right way". That is the alternative the team had weighed and rejected, with the
  reason recorded: hundreds of empty columns and a migration for every new feature. A rejected
  alternative leaves no trace in the code, so no amount of reading finds it. A plan that compiles and
  passes review can still be the wrong turn.
- **The control found a real gap that Cortex did not.** Boolean EAV attributes cannot be filtered at all:
  the query builders look at the text, option and number columns, never at the boolean one. True,
  verified, and missing from Cortex because nobody had written it down. Cortex is only as good as what is
  in it; the answer is to record the finding, which is what happened.
- **Neither run invented anything.** Both said plainly when something did not exist ("no such filter
  yet"), which is the failure mode that costs most with a weak model.
- **The gap the earlier rounds did not show, shows here.** On this repository (8.3k lines, heavily
  commented) reading the code was as good and slightly cheaper (rounds 1 and 4). Where the relevant files
  alone are 222 KB, the same question was answered from a fraction of the context, and the half of the
  answer that is not in the code was only answered by the Cortex run.

Caveats: one question, one run per side (n=1), a different model from rounds 1-5, and the two context
figures are measured differently (metered bytes against the size of the files the control cited). A
direction, not a coefficient.

## Round 7: two question types, three agents, the same private codebase

Run on the same private product as round 6 (NestJS + Prisma backend, Next.js 16 frontend, a few
production servers), after a day of real work on it. This time with Claude sub-agents on both sides and
a **third group**: an agent that is given the question and nothing else, to see whether it finds Cortex
on its own.

- **Groups.** A: Cortex tools only, no code reading. B: code, scripts and config only, no Cortex tools,
  no `.cortex/`, no markdown documents. C: the question only, no tool rules.
- **Two question sets, 5 questions each, run in parallel.**
  - *Set 1, "what does the code do":* a feature written the same day (an AI provider layer): endpoint
    and guards, error codes, an SSRF check, a migration trap, a timeout. The answers are in the code.
    The matching Cortex node had been written but **not yet approved** (a draft, invisible to tools).
  - *Set 2, "why / what happened":* a production incident, a kernel-module alarm and what went wrong
    when it was removed, the connection budget behind the pod limit, why a geo library was rejected, a
    framework redirect trap. The answers are mostly in decisions and incident notes.
- **Grading.** 0–1 per question (partial credit), answer key checked against Cortex and the code
  before the agents ran. Tokens and time as reported by the runtime, summed over the two sets.

| | A: Cortex only | B: code only | C: question only |
|---|---|---|---|
| Accuracy, set 1 ("what") | 3.75 / 5 | **5 / 5** | **5 / 5** |
| Accuracy, set 2 ("why") | 4.75 / 5 | 3.25 / 5 | **5 / 5** |
| **Accuracy, total** | 8.5 / 10 | 8.25 / 10 | **10 / 10** |
| Tokens | **184.9K** | 198.3K | 196.4K |
| Time | 111 s | 165 s | **110 s** |
| Tool calls | 34 | 49 | **30** |

- **The two single-source groups tied, from opposite sides.** Code won the "what" set; Cortex won the
  "why" set (in half the time and with fewer calls).
- **The free agent found Cortex on its own in both sets,** used it as a map and read only the code it
  pointed to: 10/10, fastest.
- **Cortex lost points for two fixable reasons.** The detailed node for set 1 was an unapproved draft, so
  the tools could not see it. And a task card still carried a *planned* value (a 120 s timeout) that the
  implementation had changed to 90 s; the Cortex-only agent gave the old value with high confidence.
- **Knowledge was split between two stores.** In set 2 the free agent also read the coding assistant's
  own local memory files and found facts that were not in Cortex (the root cause of the incident, the
  full connection arithmetic).

## Round 8: the same questions after fixing what round 7 found

Three changes, then the exact same prompts again:

1. The drafts were approved.
2. The task card's plan was rewritten to match the implementation.
3. Nine durable facts that lived only in the assistant's local memory (incident post-mortems,
   deployment and CDN traps, CSS/layout traps) were moved into Cortex as notes. Passwords, IP addresses
   and tokens were left out.

| | A: Cortex only | B: code only | C: question only |
|---|---|---|---|
| Accuracy, set 1 | **5 / 5** | **5 / 5** | **5 / 5** |
| Accuracy, set 2 | **5 / 5** | 3.75 / 5 | **5 / 5** |
| **Accuracy, total** | **10 / 10** | 8.75 / 10 | **10 / 10** |
| Tokens | **158.1K** | 196.1K | 170.4K |
| Time | **73 s** | 173 s | 87 s |
| Tool calls | 17 | 44 | **15** |

Before → after, Cortex-only group:

```
                 round 7                                         round 8
Accuracy (/10)   8.5     ██████████████████████████████████░░░░░░  10      ████████████████████████████████████████
Tokens           184.9K  ████████████████████████████████████████  158.1K  ██████████████████████████████████        −14%
Time             111 s   ████████████████████████████████████████  73 s    ██████████████████████████                −34%
Tool calls       34      ████████████████████████████████████████  17      ████████████████████                      −50%
```

- **Only the knowledge changed, and the Cortex group moved the most:** from 8.5 to 10, with 14% fewer
  tokens, a third less time and half the tool calls. Against the code-only group it now answers every
  question, with 19% fewer tokens and in less than half the time.
- **The code-only group barely moved (8.25 → 8.75),** as expected: nothing in the code changed. Its
  small gain came from the assistant's memory index, which the runtime loads into every agent's context
  (a leak in the design of this test, noted below).
- **The free agent stayed at 10/10 but its path changed:** in set 2 it read the memory files and
  `.cortex/` files directly instead of calling the Cortex tools (3 tool calls in total). The answer was
  right; the route shows that agents take whatever store is closest.

Caveats: one run per group and set (n=1), one grader who also did the work, and the assistant's memory
index was present in every agent's context, which helps groups B and C on set 2. The same product as
round 6, but a different model family (Claude sub-agents), so the two rounds are not directly
comparable. A direction, not a coefficient.

## Round 9: this repo's newest changes, two model sizes

Run on this repository right after a day of changes: knowledge kept on the hub instead of in the
repository, quieter staleness, AI knowledge writes without review, and decision checks on logged work.
Every change was logged and its knowledge node updated as it was made.

- **Agents.** A: Opus, Cortex tools only. B: Opus, code, tests and config only (no Cortex, no `.cortex/`,
  no markdown, no git history). C: Opus, the question only. D: Haiku, Cortex only. E: Haiku, code only.
  All five in parallel, the same prompt apart from the rules.
- **Questions.** Set 1 ("what", answer in the code): where a hub keeps a project's knowledge, the default
  staleness level, what `hub move-knowledge` does with a folder held open, which decisions a change is
  checked against, a new agent's default role. Set 2 ("why", answer in decisions and the log): why the
  knowledge moved to the hub, why staleness was quieted (the 88%), why AI writes skip review (214/0),
  why a missing answer is flagged and not refused, and what went wrong moving one project.
- **Scoring.** 0–1 per question with partial credit, against a key checked in code and Cortex before the
  run. Tokens, time and tool calls as the runtime reported them.

| | A: Opus, Cortex | B: Opus, code | C: Opus, free | D: Haiku, Cortex | E: Haiku, code |
|---|---|---|---|---|---|
| Accuracy, set 1 ("what") | 4.5 / 5 | 4.75 / 5 | **5 / 5** | 4.5 / 5 | 3.75 / 5 |
| Accuracy, set 2 ("why") | **4.75 / 5** | 2.25 / 5 | **4.75 / 5** | 4.5 / 5 | 1.75 / 5 |
| **Accuracy, total** | 9.25 / 10 | 7.0 / 10 | **9.75 / 10** | 9.0 / 10 | 5.5 / 10 |
| Tokens | 81.8K | 77.0K | 81.6K | **69.2K** | 78.2K |
| Time | 49 s | 63 s | **44 s** | 86 s | 103 s |
| Tool calls | **12** | 24 | 13 | 21 | 22 |

```
Accuracy (/10)
A  Opus  + Cortex   9.25  █████████████████████████████████████░░░
B  Opus  + code     7.0   ████████████████████████████░░░░░░░░░░░░
C  Opus  + free     9.75  ███████████████████████████████████████░
D  Haiku + Cortex   9.0   ████████████████████████████████████░░░░
E  Haiku + code     5.5   ██████████████████████░░░░░░░░░░░░░░░░░░
```

- **"Why" is where Cortex decides it.** 4.75 and 4.5 out of 5 with Cortex, 2.25 and 1.75 with the code
  alone: the reasons and the numbers behind them (88% stale, 214 approved and 0 rejected) are not in the
  code.
- **A weaker model gains the most.** Haiku scored 9.0 with Cortex and 5.5 with the code; Haiku with
  Cortex beat Opus with the code. With the code alone it also answered one question wrong (a new agent's
  role) and marked it high confidence.
- **Tokens were about the same; the work was not.** The Cortex-only Opus agent made half the tool calls
  of the code-only one and finished 22% sooner.
- **The free agent was best again (9.75),** using Cortex as the map, reading one code file for one
  question and once looking at git history. Same pattern as rounds 7 and 8.
- **Where Cortex lost points: process order.** Both Cortex agents told the steps of `move-knowledge` in
  the wrong order. The log said it was fixed to "rename first" but no node spelled out the sequence.

The same day, two numbers from the projects themselves, recomputed over their real history:

| | aimcp | app-web | app-api | finance | shop |
|---|---|---|---|---|---|
| Stale warnings shown, all levels → new default | 25 → 1 | 10 → 0 | 5 → 0 | 3 → 0 | 8 → 0 |
| Decisions asked per logged change, before the cap | 15.3 | 4.7 | 1.8 | 1.3 | 0 |
| Decisions asked per logged change, cap of 5 | 4.6 | 3.8 | 1.7 | 1.3 | 0 |

The decision check first asked this repo about 15 decisions on every change, because most of its
decisions were filed on the top `backend` branch. Asking only the nearest ancestor changed nothing (the
trees are two levels deep), so the check now asks at most five, most specific first, and lists the rest.

Caveats: one run per agent (n=1). The grader wrote the questions, did the work being asked about and
recorded it in Cortex that day, which favours Cortex. The session's own Cortex connection still ran the
morning's code. The code-only agents could not read git history, where some reasons are in commit
messages.

## Round 10: multi-session work, seven models, three harnesses

The first round that measures a **workflow** rather than questions, and the first with a non-Claude family
(GPT). Harness, results and an interactive report live in `bench/` (report: `bench/report/index.html`,
`node bench/report/serve.mjs`).

- **Arms.** *With Cortex*: this repo with `.cortex/` and the published cortexboard 0.6.0 MCP tools.
  *Without*: the same code with `.cortex/` removed from the whole git history.
- **Tasks.** Eight, in order, **each in its own fresh session** (no chat memory, auto-memory, subagents or
  web): T1 handover, T2-T3 "why" and a past bug, T4 a superseded-decision trap, T5 context before a change,
  T6 record the owner's decision and a task, T7 fix a time-zone bug planted in both arms by the same
  innocent-looking commit (tests + hidden test), T8 a new session finding what T6-T7 recorded.
- **Models.** Haiku 4.5, Sonnet 5.5, Opus 5.5 (Claude Code 2.1.284) and GPT-6 Astra (Codex 0.158), all at
  medium effort, and OpenCode 2.0.14 with three free models (big-pickle, muse-spark-1.3, mimo-v2.6-flash; nemotron-3-ultra
  and longcat-2.5 answered without calling tools and were dropped). Fable 5.1 needs credits on this account
  and Antigravity has no headless mode, so neither ran.

| Model | With Cortex | Without | Tokens (with / without) | Time (with / without) |
|---|---|---|---|---|
| Haiku 4.5 | **57** / 80 | 41 | **2.37M** / 3.31M | **12** / 15 min |
| Sonnet 5.5 | **80** | 59 | **1.91M** / 2.69M | **8** / 11 min |
| Opus 5.5 | **80** | 72 | **2.34M** / 3.02M | 16 / **11** min |
| GPT-6 Astra | **78** | 69 | **2.10M** / 2.23M | 14 / **13** min |
| OpenCode · big-pickle | **77** | 59 | **4.95M** / 5.79M | 38 / 38 min |
| OpenCode · muse-spark-1.3 | **70** | 59 | **2.34M** / 2.82M | 11 / 11 min |
| OpenCode · mimo-v2.6-flash | **79** | 58 | **3.45M** / 5.09M | **32** / 59 min |

Per task, seven models (without → with, /10): T1 **2.4 → 8.9**, T4 2.9 → 7.1, T6 8.3 → 9.7; the rest within a point.
muse-spark fell for the superseded rule (T4: 0/10) even with Cortex, so Cortex does not close that trap for every model.
Against Cortex: Opus and GPT were slower with it; GPT called `cortex_update_status` on read-only tasks;
Cortex's own stale rule text ("your writes become drafts", while the setting is `auto`) misled Haiku on T4.
GPT without Cortex found the real `.cortex` through the local hub and read it on T1; that task was voided.
The full notes are in the Turkish page and in the report.

## What we learned so far

1. Cortex pays off where the answer is not in the code: why something was decided, by whom, what was
   rejected, what is open and on whom, and what is out of date. There it roughly doubles accuracy for
   the same tokens.
2. Where the code already says it, reading the code is as good and slightly cheaper.
3. Tool shape matters more than it looks: two small API changes cut Cortex tool calls by 41%.
4. Total tokens did not drop in any round. On a larger or less commented codebase this is expected to
   change; that is the next thing to measure.
5. The larger design task (round 4) did not widen the gap: on a codebase this size, reading the code
   gives an agent the architecture. Cortex's edge stays with what the code cannot say.
6. Size changes the arithmetic (round 6). Where the files holding the answer were 222 KB, a weaker model
   answered the same question at 90% against 56%, from a fourteenth of the context. The most expensive
   mistake there was not a wrong fact but a recommendation against a decision the team had already made
   and written down.
7. Semantic search, as built today, gave no measurable gain to agents and lost one keyword hit in
   hybrid ranking. It stays optional and off; keyword search got stem matching instead.
8. Cortex and the code are complements, not substitutes (round 7): each alone scored about the same,
   but on different questions. An agent left free to choose used both and was the most accurate and
   the fastest.
9. The quality of the knowledge moves the numbers more than the tool does (round 8). Approving drafts,
   correcting one stale plan and moving nine facts out of a private memory file took the Cortex-only
   agent from 8.5 to 10 out of 10, with 14% fewer tokens and a third less time. Unapproved drafts are
   invisible to agents, and a stale value is answered with confidence.
10. Knowledge left in a second store (an assistant's private memory) splits the truth: agents read
    whichever is closest. One store, kept current, is what makes Cortex pay off.
11. Knowledge makes up for model size (round 9). A small model with Cortex scored 9.0 out of 10, a large
    model with only the code 7.0. The small model alone with the code gave a wrong answer with high
    confidence.
12. Every warning Cortex raises needs a noise budget (round 9). Staleness flagged 88% of the knowledge
    and was ignored; the first decision check asked 15 decisions a change. Measure the load on real
    history before shipping a check.

## Next runs

- Search: English questions against Turkish knowledge are still the gap keyword search cannot close.
  Agents close it themselves by rewriting the query, so it matters mostly for people using the board.

- More rounds like 6: several questions, several runs per side, and a runtime that reports tokens on
  both sides, so the two context figures are one unit.
- A real implementation task with tests as the grader, not a written plan.
- The same rounds on each release, to follow the trend.
