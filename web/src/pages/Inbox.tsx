import type { ReactNode } from "react";
import { useState } from "react";
import type { ApiError } from "../api";
import { api, useApi } from "../api";
import type { Key } from "../i18n";
import { useT } from "../i18n";
import type { InboxEntry, InboxReason, InboxResponse } from "../types";
import { ActorChip, Ago, EmptyState, Progress, ErrorBox, go, Icon, ListRow, Loading, StatusChip, TypeChip, useAsk, useSession, useToast } from "../ui";
import { StatusCard, useStatus } from "../StatusCard";
import { DraftSizeBadge } from "./Approvals";
import { SeverityChip } from "./Knowledge";
import { ToTest, WaitingChip } from "../review";

// Notifications: one queue of everything waiting for this person, grouped by what they do with it.
// The server builds, counts and filters the queue (GET /api/inbox); the page only draws it. Reviewed work,
// drafts and decisions can be settled from the row; everything else opens where it lives.

const PAGE = 100;

export function Inbox() {
  const t = useT();
  const toast = useToast();
  const { dialog, ask } = useAsk();
  const { actors, openItem, can } = useSession();
  const [limit, setLimit] = useState(PAGE);
  // One request, refreshed only by changes that can move something in or out of the queue.
  const status = useStatus();
  const inbox = useApi<InboxResponse>(`/api/inbox?limit=${limit}`, { on: ["item", "draft", "node", "stale", "git"] });
  // Rows settled from here disappear at once; the live refresh then brings the server's word.
  const [settled, setSettled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const quick = can("approve");

  const all = (inbox.data?.items ?? []).filter((e) => !settled.has(e.id));
  const by = (reason: string, extra?: (e: InboxEntry) => boolean) => all.filter((e) => e.reason === reason && (!extra || extra(e)));
  const isBlocking = (e: InboxEntry) => !!e.blocking && e.type === "question" && e.reason !== "your_question_answered";
  const blocking = all.filter(isBlocking);
  const reviews = by("review_waiting_on_you");
  const drafts = by("draft_to_approve");
  const decisions = by("decision_needs_review");
  const discussions = by("discussion_needs_your_view");
  const mine = by("assigned_to_you", (e) => !isBlocking(e));
  const group = by("assigned_to_group", (e) => !isBlocking(e));
  const answered = by("your_question_answered");
  const replies = by("new_reply");
  const outdated = by("stale_knowledge");

  // Settled rows the server still lists (its refresh has not arrived yet) come off the server's counts.
  const pending = (inbox.data?.items ?? []).filter((e) => settled.has(e.id));
  const total = (inbox.data?.count ?? 0) - pending.length;
  const counts: Partial<Record<InboxReason, number>> = { ...inbox.data?.by_reason };
  for (const e of pending) counts[e.reason] = (counts[e.reason] ?? 1) - 1;
  const n = (key: Key, count: number | undefined) => (count ? t(key).replace("{n}", String(count)) : null);
  const summary = [
    n("notif.summaryReviews", counts.review_waiting_on_you),
    n("notif.summaryDrafts", counts.draft_to_approve),
    n("notif.summaryDecisions", counts.decision_needs_review),
    n("notif.summaryDiscussions", counts.discussion_needs_your_view),
    n("notif.summaryQuestions", blocking.length),
    n("notif.summaryTasks", (counts.assigned_to_you ?? 0) + (counts.assigned_to_group ?? 0) - blocking.length),
    n("notif.summaryStale", counts.stale_knowledge),
  ].filter(Boolean);

  // Runs one quick action; the row leaves the list when it succeeds.
  const act = async (e: InboxEntry, run: () => Promise<{ message?: string }>, done: string) => {
    setBusy(e.id);
    try {
      const r = await run();
      setSettled((s) => new Set(s).add(e.id));
      toast({ text: r.message && e.kind === "draft" ? r.message : done });
    } catch (err) {
      const conflict = (err as ApiError).code === "conflict";
      toast({
        text: (err as ApiError).message ?? String(err),
        ...(conflict ? { action: { label: t("notif.review"), run: () => go("approvals") } } : {}),
      });
    } finally {
      setBusy(null);
    }
  };
  const move = (e: InboxEntry, status: string, done: string) => act(e, () => api(`/api/items/${e.id}`, { method: "PATCH", body: { status } }), done);
  const sendBack = async (e: InboxEntry, status: string) => {
    const note = await ask({ title: t("notif.sendBack"), input: { label: t("notif.sendBackPrompt") }, confirm: t("notif.sendBack") });
    if (note === null) return;
    void act(e, () => api(`/api/items/${e.id}/replies`, { method: "POST", body: { body: note || t("notif.sentBackDefault"), status } }), t("notif.sentBack"));
  };
  const draft = async (e: InboxEntry, what: "approve" | "reject") => {
    const reason =
      what === "reject"
        ? await ask({ title: t("notif.reject"), input: { label: t("approvals.rejectReason") }, confirm: t("notif.reject"), tone: "danger" })
        : undefined;
    if (reason === null) return;
    void act(
      e,
      () => api(`/api/approvals/${e.id}/${what}`, { method: "POST", body: reason ? { reason } : {} }),
      t(what === "approve" ? "notif.approved" : "notif.rejected"),
    );
  };

  const actions = (e: InboxEntry): ReactNode => {
    if (!quick) return null;
    const off = busy !== null;
    if (e.reason === "review_waiting_on_you" && e.moves) {
      const { approve, send_back } = e.moves;
      return (
        <>
          {approve && (
            <button className="btn sm primary" disabled={off} onClick={() => void move(e, approve, t("notif.approved"))}>
              {t("notif.approve")}
            </button>
          )}
          {send_back && (
            <button className="btn sm" disabled={off} onClick={() => void sendBack(e, send_back)}>
              {t("notif.sendBack")}
            </button>
          )}
        </>
      );
    }
    if (e.reason === "decision_needs_review") {
      return (
        <>
          <button className="btn sm primary" disabled={off} onClick={() => void move(e, "accepted", t("notif.accepted"))}>
            {t("notif.accept")}
          </button>
          <button className="btn sm danger" disabled={off} onClick={() => void move(e, "rejected", t("notif.rejected"))}>
            {t("notif.reject")}
          </button>
        </>
      );
    }
    if (e.reason === "draft_to_approve") {
      // A risky draft is read before it is approved: no approving it from the row.
      return (
        <>
          {e.changes?.risky ? (
            <button className="btn sm" disabled={off} onClick={() => go("approvals")}>
              {t("notif.review")}
            </button>
          ) : (
            <button className="btn sm primary" disabled={off} onClick={() => void draft(e, "approve")}>
              {t("notif.approve")}
            </button>
          )}
          <button className="btn sm danger" disabled={off} onClick={() => void draft(e, "reject")}>
            {t("notif.reject")}
          </button>
        </>
      );
    }
    return null;
  };

  const row = (e: InboxEntry, open: () => void, body: ReactNode, below?: ReactNode) => {
    const extra = actions(e);
    return (
      <div className={`inbox-row${below ? " with-below" : ""}`} key={e.id}>
        <ListRow onPress={open}>
          <div className="grow">{body}</div>
          {!extra && (
            <span className="row-go" aria-hidden>
              <Icon name="chevron" size={16} />
            </span>
          )}
        </ListRow>
        {extra && (
          <div className="row-actions" role="group" aria-label={e.title}>
            {extra}
          </div>
        )}
        {below}
      </div>
    );
  };

  const itemRow = (e: InboxEntry) =>
    row(
      e,
      () => (e.type === "discussion" ? go(`discussions/${e.id}`) : openItem(e.id)),
      <>
        <div className="title">{e.title}</div>
        <div className="meta">
          <TypeChip type={e.type!} />
          <StatusChip status={e.status!} />
          <ActorChip id={e.author!} actors={actors} />
          {e.category_path && <span className="faint">{e.category_path}</span>}
          {e.checklist && <Progress done={e.checklist.done} total={e.checklist.total} />}
          {e.updated_at && <Ago iso={e.updated_at} />}
          {e.reason === "review_waiting_on_you" && <WaitingChip since={e.waiting_since} />}
        </div>
      </>,
      e.reason === "review_waiting_on_you" && e.to_test?.length ? <ToTest id={e.id} steps={e.to_test} since={e.waiting_since} /> : undefined,
    );

  const draftRow = (e: InboxEntry) =>
    row(
      e,
      () => go("approvals"),
      <>
        <div className="title">{e.title}</div>
        <div className="meta">
          <TypeChip type={e.draft_kind!} />
          <span className="mono faint">{e.draft_kind === "node" ? e.target || "(root)" : e.target!.slice(-8)}</span>
          <DraftSizeBadge size={e.changes} />
          <ActorChip id={e.proposed_by!} actors={actors} />
        </div>
      </>,
    );

  const staleRow = (e: InboxEntry) =>
    row(
      e,
      () => go(`knowledge/${e.path}`),
      <>
        <div className="title">
          {e.title} <SeverityChip severity={e.severity as "high" | "medium" | "low"} />
        </div>
        <div className="meta">
          <span className="faint mono">{(e.changed_files ?? []).join(", ")}</span>
        </div>
      </>,
    );

  const shown = inbox.data?.items.length ?? 0;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("notif.title")}</h1>
        </div>
      </div>
      {inbox.error && <ErrorBox error={inbox.error} />}
      {/* Everything that depends on the data arrives together, in the skeleton's place: a summary line that
          grows to three lines on a phone must not push content that is already on screen. */}
      {inbox.loading || status.loading ? (
        <Loading />
      ) : (
        <>
          <p className="inbox-summary">
            {total === 0
              ? t("notif.nothing")
              : `${total === 1 ? t("notif.waitingOne") : t("notif.waitingCount").replace("{n}", String(total))} · ${summary.join(" · ")}`}
          </p>
          <StatusCard res={status} />
        </>
      )}
      {inbox.loading || status.loading ? null : total === 0 ? (
        <EmptyState icon="check" title={t("notif.nothing")} hint={t("inbox.empty")} />
      ) : (
        <div className="notif-groups">
          <Group title={t("notif.blocking")} why={t("notif.blockingWhy")} tone="danger" rows={blocking.map(itemRow)} />
          <Group title={t("notif.reviews")} why={t("notif.reviewsWhy")} count={counts.review_waiting_on_you} rows={reviews.map(itemRow)} />
          <Group
            title={t("notif.drafts")}
            why={t("notif.draftsWhy")}
            count={counts.draft_to_approve}
            action={{ label: t("notif.review"), run: () => go("approvals") }}
            rows={drafts.map(draftRow)}
          />
          <Group title={t("notif.decisions")} why={t("notif.decisionsWhy")} count={counts.decision_needs_review} rows={decisions.map(itemRow)} />
          <Group title={t("notif.discussions")} why={t("notif.discussionsWhy")} rows={discussions.map(itemRow)} />
          <Group title={t("notif.assigned")} why={t("notif.assignedWhy")} rows={mine.map(itemRow)} />
          <Group title={t("notif.group")} why={t("notif.groupWhy")} rows={group.map(itemRow)} />
          <Group title={t("notif.answered")} why={t("notif.answeredWhy")} rows={answered.map(itemRow)} />
          <Group title={t("notif.replies")} why={t("notif.repliesWhy")} rows={replies.map(itemRow)} />
          <Group title={t("notif.stale")} why={t("notif.staleWhy")} tone="warn" count={counts.stale_knowledge} rows={outdated.map(staleRow)} />
          {shown < (inbox.data?.count ?? 0) && (
            <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>
              {t("notif.more").replace("{n}", String((inbox.data?.count ?? 0) - shown))}
            </button>
          )}
        </div>
      )}
      {dialog}
    </>
  );
}

function Group({
  title,
  why,
  rows,
  count,
  tone,
  action,
}: {
  title: string;
  why: string;
  rows: ReactNode[];
  count?: number; // the server's total when the page holds only part of the group
  tone?: "warn" | "danger";
  action?: { label: string; run: () => void };
}) {
  if (rows.length === 0) return null;
  return (
    <section className="notif-group">
      <div className="notif-head">
        <h2>
          {title} <span className={`count ${tone ?? ""}`}>{Math.max(rows.length, count ?? 0)}</span>
        </h2>
        <p>{why}</p>
        {action && (
          <button className="btn sm" onClick={action.run}>
            {action.label}
          </button>
        )}
      </div>
      <div className="card list">{rows}</div>
    </section>
  );
}
