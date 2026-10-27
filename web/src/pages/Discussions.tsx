import { useState } from "react";
import { api, useApi } from "../api";
import type { Key } from "../i18n";
import { useLabels, useT } from "../i18n";
import { useBranches } from "../items";
import type { Item, Reply } from "../types";
import { ActorChip, Ago, Avatar, EmptyState, ErrorBox, go, Icon, Loading, Markdown, Modal, Pressable, StatusChip, useSession, useToast } from "../ui";

// Discussions: a question put to people and AI agents. Its own screens, apart from the board: a list of
// discussions, and one discussion laid out as a table of views per option with the vote and the decision.
// The server hides the others' views during the blind round; this page only shows what it is given.

interface Tally {
  votes: { option: string; voters: string[] }[];
  leader: string | null;
  tie: boolean;
}
interface Row {
  id: string;
  title: string;
  status: string;
  author: string;
  category_path?: string;
  options: string[];
  participants: string[];
  blind: boolean;
  deadline?: string;
  outcome?: string;
  posted: string[];
  waiting_on: string[];
  asks_you: boolean;
  replies: number;
  tally?: Tally;
  updated_at: string;
}
interface Summary {
  blind_round: boolean;
  sees_all: boolean;
  posted: string[];
  waiting_on: string[];
  asks_you: boolean;
  tally?: Tally;
}
type View = Reply & { sealed?: boolean };

const TALKING = ["open", "deliberating"];
const KINDS = ["opinion", "rebuttal", "synthesis", "comment"] as const;
type Kind = (typeof KINDS)[number];
const kindOf = (r: Reply) => (typeof r.fields?.kind === "string" ? (r.fields.kind as Kind) : "comment");
const listOf = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

// ---- list -----------------------------------------------------------------------------

export function Discussions() {
  const t = useT();
  const { can } = useSession();
  const [open, setOpen] = useState(true);
  const [creating, setCreating] = useState(false);
  const { data, error, loading } = useApi<{ discussions: Row[] }>(`/api/discussions${open ? "?open=true" : ""}`, { on: ["item"] });
  const rows = [...(data?.discussions ?? [])].sort((a, b) => Number(b.asks_you) - Number(a.asks_you) || (a.updated_at < b.updated_at ? 1 : -1));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("disc.title")}</h1>
          <p>{t("disc.intro")}</p>
        </div>
        <div className="page-actions">
          <div className="segmented" role="group" aria-label={t("disc.title")}>
            <button className={open ? "on" : ""} aria-pressed={open} onClick={() => setOpen(true)}>
              {t("disc.filterOpen")}
            </button>
            <button className={!open ? "on" : ""} aria-pressed={!open} onClick={() => setOpen(false)}>
              {t("disc.filterAll")}
            </button>
          </div>
          {can("write_items") && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" /> {t("disc.new")}
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="debate"
          title={t("disc.empty")}
          hint={t("disc.aiHint")}
          action={can("write_items") ? { label: t("disc.new"), run: () => setCreating(true) } : undefined}
        />
      ) : (
        <div className="disc-grid">
          {rows.map((r) => (
            <DiscussionCard key={r.id} row={r} />
          ))}
        </div>
      )}
      {creating && <NewDiscussionDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function DiscussionCard({ row }: { row: Row }) {
  const t = useT();
  const { actors } = useSession();
  const people = row.participants.length ? row.participants : row.posted;
  return (
    <Pressable as="article" className={`card disc-card${row.asks_you ? " asks" : ""}`} onPress={() => go(`discussions/${row.id}`)} label={row.title}>
      <div className="disc-card-top">
        <StatusChip status={row.status} />
        {row.asks_you && <span className="chip accent">{t("disc.asksYou")}</span>}
        {row.blind && row.status === "open" && (
          <span className="chip" title={t("disc.blindWhy")}>
            <Icon name="eye" size={12} /> {t("disc.blind")}
          </span>
        )}
        <span className="spacer" />
        <span className="faint">
          <Ago iso={row.updated_at} />
        </span>
      </div>
      <h3 className="disc-card-title">{row.title}</h3>
      <VoteBars options={row.options} tally={row.tally} compact />
      <div className="disc-card-foot">
        <div className="disc-avatars">
          {people.slice(0, 8).map((p) => (
            <span key={p} className={row.posted.includes(p) ? "" : "waiting"}>
              <Avatar id={p} actors={actors} />
            </span>
          ))}
        </div>
        <span className="faint">
          {row.participants.length
            ? t("disc.postedOf")
                .replace("{n}", String(row.participants.filter((p) => row.posted.includes(p)).length))
                .replace("{m}", String(row.participants.length))
            : t("disc.postedAny").replace("{n}", String(row.posted.length))}
        </span>
      </div>
    </Pressable>
  );
}

// Options with their vote share. Without a tally (blind round) the options are listed without counts.
function VoteBars({ options, tally, compact }: { options: string[]; tally?: Tally; compact?: boolean }) {
  const t = useT();
  const { actors } = useSession();
  const total = tally ? tally.votes.reduce((n, v) => n + v.voters.length, 0) : 0;
  return (
    <ul className={`vote-bars${compact ? " compact" : ""}`}>
      {options.map((o, i) => {
        const voters = tally?.votes.find((v) => v.option === o)?.voters ?? [];
        const share = total ? Math.round((voters.length / total) * 100) : 0;
        const lead = tally?.leader === o;
        return (
          <li key={o} className={lead ? "lead" : ""}>
            <div className="vote-line">
              <span className={`opt-dot o${i % 6}`} aria-hidden />
              <span className="vote-option">{o}</span>
              {tally && <span className="vote-count">{voters.length}</span>}
            </div>
            {tally && (
              <div className="vote-track" aria-hidden>
                <span className={`o${i % 6}`} style={{ width: `${share}%` }} />
              </div>
            )}
            {!compact && voters.length > 0 && (
              <div className="vote-voters">
                {voters.map((v) => (
                  <ActorChip key={v} id={v} actors={actors} />
                ))}
              </div>
            )}
          </li>
        );
      })}
      {!tally && !compact && <li className="faint">{t("disc.hiddenVotes")}</li>}
    </ul>
  );
}

// ---- new discussion ---------------------------------------------------------------------

function NewDiscussionDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { actors, me } = useSession();
  const branches = useBranches();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [participants, setParticipants] = useState<string[]>([]);
  const [blind, setBlind] = useState(true);
  const [deadline, setDeadline] = useState("");
  const [category, setCategory] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const toggle = (id: string) => setParticipants((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const others = actors.filter((a) => a.id !== me.id);
  const sorted = [...others.filter((a) => a.kind === "ai"), ...others.filter((a) => a.kind !== "ai")];

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ id: string }>("/api/items", {
        method: "POST",
        body: {
          type: "discussion",
          title: title.trim(),
          body,
          ...(category ? { category_path: category } : {}),
          fields: {
            options: filled,
            ...(participants.length ? { participants } : {}),
            ...(blind ? {} : { blind: false }),
            ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
          },
        },
      });
      onClose();
      go(`discussions/${r.id}`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t("disc.new")}>
      <div className="field">
        <label htmlFor="disc-title">
          {t("disc.question")} <span className="req">*</span>
        </label>
        <input id="disc-title" className="input" autoFocus value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="disc-body">{t("disc.context")}</label>
        <textarea id="disc-body" className="textarea" placeholder={t("disc.contextHint")} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <fieldset className="field disc-fieldset">
        <legend>
          {t("disc.options")} <span className="req">*</span>
        </legend>
        <p className="hint">{t("disc.optionsHint")}</p>
        {options.map((o, i) => (
          <div className="disc-option-input" key={i}>
            <span className={`opt-dot o${i % 6}`} aria-hidden />
            <input
              className="input"
              value={o}
              maxLength={200}
              aria-label={t("disc.optionPlaceholder").replace("{n}", String(i + 1))}
              placeholder={t("disc.optionPlaceholder").replace("{n}", String(i + 1))}
              onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
            />
            {options.length > 2 && (
              <button className="icon-btn" aria-label={t("disc.removeOption")} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                <Icon name="x" />
              </button>
            )}
          </div>
        ))}
        {options.length < 8 && (
          <button className="btn ghost sm" onClick={() => setOptions([...options, ""])}>
            <Icon name="plus" /> {t("disc.addOption")}
          </button>
        )}
      </fieldset>
      <fieldset className="field disc-fieldset">
        <legend>{t("disc.participants")}</legend>
        <p className="hint">{t("disc.participantsHint")}</p>
        <div className="disc-people">
          {sorted.map((a) => (
            <label key={a.id} htmlFor={`disc-p-${a.id}`} className={`disc-person${participants.includes(a.id) ? " on" : ""}`}>
              <input id={`disc-p-${a.id}`} type="checkbox" checked={participants.includes(a.id)} onChange={() => toggle(a.id)} />
              <Avatar id={a.id} actors={actors} />
              <span>{a.id}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid2">
        <div className="field">
          <label htmlFor="disc-deadline">{t("disc.deadline")}</label>
          <input id="disc-deadline" className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="disc-category">{t("item.category")}</label>
          <select id="disc-category" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">—</option>
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor="disc-blind" className="check">
        <input id="disc-blind" type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} /> {t("disc.blind")}
      </label>
      <p className="faint opinion-sub">{t("disc.blindWhy")}</p>
      <ErrorBox error={err} />
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" disabled={busy || !title.trim() || filled.length < 2} onClick={() => void submit()}>
          {t("disc.create")}
        </button>
      </div>
    </Modal>
  );
}

// ---- one discussion ---------------------------------------------------------------------

export function DiscussionView({ id }: { id: string }) {
  const t = useT();
  const toast = useToast();
  const { actors, me, can, openItem } = useSession();
  const { data, error, loading, reload } = useApi<{ item: Item; replies: View[]; discussion?: Summary }>(`/api/items/${id}`, { on: ["item"] });
  const outcomeId = typeof data?.item.fields.outcome === "string" ? data.item.fields.outcome : null;
  const outcome = useApi<{ item: Item }>(outcomeId ? `/api/items/${outcomeId}` : null, { on: ["item"] });
  const [layout, setLayout] = useState<"options" | "timeline">("options");

  if (loading || !data) return error ? <ErrorBox error={error} /> : <Loading />;
  const { item, replies } = data;
  const s = data.discussion;
  if (item.type !== "discussion" || !s) return <ErrorBox error={new Error(t("disc.noViewsYet"))} />;
  const options = listOf(item.fields.options);
  const participants = listOf(item.fields.participants);
  const talking = TALKING.includes(item.status);
  const human = me.kind === "human";

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ text: ok });
      reload();
      outcome.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  const move = (status: string) => run(() => api(`/api/items/${id}`, { method: "PATCH", body: { status } }));
  const count = () => run(() => api(`/api/discussions/${id}/close-vote`, { method: "POST", body: {} }), t("disc.counted"));
  const decide = (option: string) =>
    run(() => api(`/api/discussions/${id}/decide`, { method: "POST", body: { option } }), t("disc.decided").replace("{option}", option));
  const accept = (decisionId: string) => run(() => api(`/api/items/${decisionId}`, { method: "PATCH", body: { status: "accepted" } }));

  const phase: Key =
    item.status === "open"
      ? s.blind_round
        ? "disc.phaseOpen"
        : "disc.phaseOpenVisible"
      : item.status === "deliberating"
        ? "disc.phaseDeliberating"
        : item.status === "voted"
          ? "disc.phaseVoted"
          : item.status === "decided"
            ? "disc.phaseDecided"
            : "disc.phaseCancelled";

  const decision = outcome.data?.item;

  return (
    <div className="disc">
      <a className="disc-back" href="#/discussions">
        <Icon name="chevron" size={14} /> {t("disc.back")}
      </a>
      <header className="disc-head">
        <div className="disc-head-meta">
          <StatusChip status={item.status} />
          <ActorChip id={item.author} actors={actors} />
          {item.category_path && <span className="faint">{item.category_path}</span>}
          <Ago iso={item.created_at} />
          {typeof item.fields.deadline === "string" && (
            <span className="chip" title={t("disc.deadline")}>
              <Icon name="clock" size={12} /> {new Date(item.fields.deadline).toLocaleString()}
            </span>
          )}
        </div>
        <h1>{item.title}</h1>
        <Markdown text={item.body} />
        <p className={`disc-phase ${item.status}`}>
          <Icon name={s.blind_round ? "eye" : "debate"} size={14} /> {t(phase)}
        </p>
      </header>

      <div className="disc-layout">
        <section className="disc-main">
          {!s.sees_all && (
            <div className="disc-sealed-banner">
              <Icon name="lock" size={14} /> {t("disc.sealedBanner")}
            </div>
          )}
          <div className="disc-toolbar">
            <div className="segmented" role="group" aria-label={t("disc.title")}>
              <button className={layout === "options" ? "on" : ""} aria-pressed={layout === "options"} onClick={() => setLayout("options")}>
                {t("disc.byOption")}
              </button>
              <button className={layout === "timeline" ? "on" : ""} aria-pressed={layout === "timeline"} onClick={() => setLayout("timeline")}>
                {t("disc.timeline")}
              </button>
            </div>
          </div>
          {layout === "options" ? <ByOption options={options} replies={replies} /> : <Timeline options={options} replies={replies} />}
          {can("ask") && item.status !== "decided" && item.status !== "cancelled" && (
            <Composer
              id={id}
              status={item.status}
              options={options}
              mayVote={!participants.length || participants.includes(me.id) || item.author === me.id}
              posted={s.posted.includes(me.id)}
              onPosted={reload}
            />
          )}
        </section>

        <aside className="disc-side">
          <div className="card disc-panel">
            <h3>{t("disc.votes")}</h3>
            <VoteBars options={options} tally={s.tally} />
          </div>

          <div className="card disc-panel">
            <h3>{t("disc.participants")}</h3>
            {participants.length === 0 && <p className="faint">{t("disc.everyone")}</p>}
            <ul className="disc-roster">
              {(participants.length ? participants : s.posted).map((p) => (
                <li key={p}>
                  <Avatar id={p} actors={actors} />
                  <span className="disc-roster-name">{p}</span>
                  {s.posted.includes(p) ? <Icon name="check" size={14} /> : <span className="faint">…</span>}
                </li>
              ))}
            </ul>
            {talking && <p className="faint disc-note">{t("disc.aiHint")}</p>}
          </div>

          <div className="card disc-panel">
            <h3>{t("disc.decision")}</h3>
            {decision && (
              <div className="disc-outcome">
                <div className="disc-outcome-head">
                  <StatusChip status={decision.status} />
                  {decision.status === "proposed" && <span className="faint">{t("disc.proposed")}</span>}
                </div>
                <strong>{decision.body.split("\n")[0]}</strong>
                <div className="disc-actions">
                  <button className="btn sm" onClick={() => openItem(decision.id)}>
                    {t("disc.openDecision")}
                  </button>
                  {decision.status === "proposed" && human && can("approve") && (
                    <button className="btn sm primary" onClick={() => void accept(decision.id)}>
                      <Icon name="check" /> {t("disc.accept")}
                    </button>
                  )}
                </div>
              </div>
            )}
            {item.status === "voted" && !decision && s.tally && <p className="muted">{s.tally.tie ? t("disc.tie") : t("disc.noMajority")}</p>}
            {item.status !== "decided" && item.status !== "cancelled" && (
              <>
                {human && can("approve") ? (
                  item.status === "voted" && (
                    <ul className="disc-decide">
                      {options.map((o, i) => (
                        <li key={o}>
                          <span className={`opt-dot o${i % 6}`} aria-hidden />
                          <span className="vote-option">{o}</span>
                          <button className="btn sm" onClick={() => void decide(o)}>
                            {t("disc.decideWith")}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : (
                  <p className="faint">{t("disc.onlyHumans")}</p>
                )}
                {can("write_items") && (
                  <div className="disc-actions">
                    {item.status === "open" && (
                      <button className="btn sm" onClick={() => void move("deliberating")}>
                        <Icon name="eye" /> {t("disc.openViews")}
                      </button>
                    )}
                    {talking && (
                      <button className="btn sm primary" onClick={() => void count()}>
                        <Icon name="check" /> {t("disc.closeVote")}
                      </button>
                    )}
                    {item.status === "voted" && (
                      <button className="btn sm" onClick={() => void move("deliberating")}>
                        {t("disc.reopen")}
                      </button>
                    )}
                    <button className="btn sm ghost" onClick={() => void move("cancelled")}>
                      {t("disc.cancel")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// Each voter's latest view, in the column of the option it backs. Comments and syntheses sit below.
function ByOption({ options, replies }: { options: string[]; replies: View[] }) {
  const t = useT();
  const latest = new Map<string, View>();
  for (const r of replies) {
    const k = kindOf(r);
    if ((k === "opinion" || k === "rebuttal") && typeof r.fields?.stance === "string") latest.set(r.author, r);
  }
  const sealed = replies.filter((r) => r.sealed);
  const loose = replies.filter((r) => !r.sealed && (kindOf(r) === "synthesis" || kindOf(r) === "comment"));
  if (!replies.length) return <EmptyState icon="chat" title={t("disc.noViewsYet")} />;
  return (
    <>
      <div className="disc-columns">
        {options.map((o, i) => {
          const views = [...latest.values()].filter((r) => r.fields?.stance === o);
          return (
            <div className="disc-column" key={o}>
              <div className="disc-column-head">
                <span className={`opt-dot o${i % 6}`} aria-hidden />
                <span className="vote-option">{o}</span>
                <span className="vote-count">{views.length}</span>
              </div>
              {views.map((r) => (
                <ViewCard key={r.id} r={r} options={options} />
              ))}
            </div>
          );
        })}
      </div>
      {sealed.length > 0 && (
        <div className="disc-sealed-list">
          {sealed.map((r) => (
            <ViewCard key={r.id} r={r} options={options} />
          ))}
        </div>
      )}
      {loose.length > 0 && (
        <div className="disc-loose">
          {loose.map((r) => (
            <ViewCard key={r.id} r={r} options={options} />
          ))}
        </div>
      )}
    </>
  );
}

function Timeline({ options, replies }: { options: string[]; replies: View[] }) {
  const t = useT();
  if (!replies.length) return <EmptyState icon="chat" title={t("disc.noViewsYet")} />;
  return (
    <div className="disc-timeline">
      {replies.map((r) => (
        <ViewCard key={r.id} r={r} options={options} />
      ))}
    </div>
  );
}

function ViewCard({ r, options }: { r: View; options: string[] }) {
  const t = useT();
  const label = useLabels();
  const { actors, openItem } = useSession();
  if (r.sealed) {
    return (
      <div className="view-card sealed">
        <div className="view-head">
          <Avatar id={r.author} actors={actors} />
          <strong>{r.author}</strong>
          <Ago iso={r.created_at} />
        </div>
        <p className="faint">
          <Icon name="lock" size={12} /> {t("disc.sealed")}
        </p>
      </div>
    );
  }
  const kind = kindOf(r);
  const stance = typeof r.fields?.stance === "string" ? r.fields.stance : null;
  const idx = stance ? options.indexOf(stance) : -1;
  const evidence = listOf(r.fields?.evidence);
  return (
    <div className={`view-card ${kind}`}>
      <div className="view-head">
        <Avatar id={r.author} actors={actors} />
        <strong>{r.author}</strong>
        <span className={`chip${kind === "opinion" ? " accent" : kind === "rebuttal" ? " warn" : ""}`}>{t(`disc.kind.${kind}` as Key)}</span>
        {typeof r.fields?.confidence === "string" && (
          <span className="chip" title={t("disc.confidence")}>
            {t("disc.confidence")}: {label.value(r.fields.confidence)}
          </span>
        )}
        <span className="spacer" />
        <Ago iso={r.created_at} />
      </div>
      {stance && (
        <div className="view-stance">
          <span className={`opt-dot o${Math.max(idx, 0) % 6}`} aria-hidden /> {stance}
        </div>
      )}
      <Markdown text={r.body} />
      {evidence.length > 0 && (
        <div className="view-evidence">
          <span className="faint">{t("disc.evidence")}:</span>
          {evidence.map((e) => (
            <Evidence key={e} ref_={e} open={openItem} />
          ))}
        </div>
      )}
    </div>
  );
}

// An item id opens the item, a path with a dot or a colon is code, anything else is a knowledge path.
function Evidence({ ref_, open }: { ref_: string; open: (id: string) => void }) {
  if (/^[0-9A-Z]{26}$/.test(ref_)) {
    return (
      <button className="chip mono evidence-link" onClick={() => open(ref_)}>
        {ref_.slice(-8)}
      </button>
    );
  }
  if (/[.:]/.test(ref_)) return <span className="chip mono">{ref_}</span>;
  return (
    <a className="chip mono evidence-link" href={`#/knowledge/${ref_}`}>
      {ref_}
    </a>
  );
}

function Composer({
  id,
  status,
  options,
  mayVote,
  posted,
  onPosted,
}: {
  id: string;
  status: string;
  options: string[];
  mayVote: boolean;
  posted: boolean;
  onPosted: () => void;
}) {
  const t = useT();
  const label = useLabels();
  const toast = useToast();
  // What this phase accepts: views while it is running (rebuttals and syntheses once views are open), comments always.
  const kinds: Kind[] = !TALKING.includes(status)
    ? ["comment"]
    : status === "open"
      ? mayVote
        ? ["opinion", "comment"]
        : ["comment"]
      : mayVote
        ? [...KINDS]
        : ["synthesis", "comment"];
  const [kind, setKind] = useState<Kind>(kinds.includes(posted ? "rebuttal" : "opinion") ? (posted ? "rebuttal" : "opinion") : kinds[0]!);
  const [stance, setStance] = useState("");
  const [confidence, setConfidence] = useState("medium");
  const [evidence, setEvidence] = useState("");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const votes = kind === "opinion" || kind === "rebuttal";

  const submit = async () => {
    setBusy(true);
    setErr(null);
    const ev = evidence
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    const fields: Record<string, unknown> = { kind };
    if (votes && stance) fields.stance = stance;
    if (votes) fields.confidence = confidence;
    if (ev.length) fields.evidence = ev;
    try {
      await api(`/api/items/${id}/replies`, { method: "POST", body: { body, fields } });
      toast({ text: t("disc.posted") });
      setBody("");
      setEvidence("");
      onPosted();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card disc-composer">
      <div className="disc-composer-head">
        <h3>{t("disc.yourView")}</h3>
        <div className="segmented" role="group" aria-label={t("disc.yourView")}>
          {kinds.map((k) => (
            <button key={k} className={kind === k ? "on" : ""} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {t(`disc.kind.${k}` as Key)}
            </button>
          ))}
        </div>
      </div>
      <p className="faint disc-note">{t(`disc.kindHint.${kind}` as Key)}</p>
      {votes && (
        <div className="grid2">
          <div className="field">
            <label htmlFor="disc-stance">
              {t("disc.stance")} {kind === "opinion" && <span className="req">*</span>}
            </label>
            <select id="disc-stance" className="select" value={stance} onChange={(e) => setStance(e.target.value)}>
              <option value="">—</option>
              {options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">{t("disc.confidence")}</span>
            <div className="segmented" role="group" aria-label={t("disc.confidence")}>
              {["low", "medium", "high"].map((c) => (
                <button key={c} className={confidence === c ? "on" : ""} aria-pressed={confidence === c} onClick={() => setConfidence(c)}>
                  {label.value(c)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="disc-reason">
          {t("disc.reasoning")} <span className="req">*</span>
        </label>
        <textarea id="disc-reason" className="textarea" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      {kind !== "comment" && (
        <div className="field">
          <label htmlFor="disc-evidence">
            {t("disc.evidence")} {kind === "opinion" && <span className="req">*</span>}
          </label>
          <textarea
            id="disc-evidence"
            className="textarea mono"
            rows={3}
            placeholder={t("disc.evidenceHint")}
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
          />
        </div>
      )}
      <ErrorBox error={err} />
      <div className="disc-composer-foot">
        <button className="btn primary" disabled={busy || !body.trim() || (kind === "opinion" && (!stance || !evidence.trim()))} onClick={() => void submit()}>
          {t("disc.post")}
        </button>
      </div>
    </div>
  );
}
