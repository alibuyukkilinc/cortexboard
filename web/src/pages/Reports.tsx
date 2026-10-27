import type { ReactNode } from "react";
import { useContext, useState } from "react";
import { useRouteQuery } from "../filters";
import { apiPath, qs, useApi } from "../api";
import { HBars, StackedColumns, Timeline } from "../charts";
import { LangContext, useT } from "../i18n";
import { ActorChip, Ago, EmptyState, ErrorBox, Icon, Loading, Progress, StatusChip, useSession, useToast, ListRow } from "../ui";

// Mirrors the server's Report shape (src/core/reports.ts); only the fields the page reads.
interface Report {
  period: { since: string; until: string; days: number };
  totals: {
    activity: { logged: { total: number; ai: number; human: number; unknown: number }; system: { total: number } };
    ai_logged_changes: number;
    ai_changes_without_why: number;
    items_created: { total: number };
    items_closed: { total: number };
    questions: { asked: number; answered: number; median_answer_hours: number | null; open_blocking: number };
    decisions: { proposed: number; accepted: number; rejected: number };
    approvals: { proposed: number; approved: number; rejected: number; pending: number };
  };
  daily: { date: string; ai: number; human: number; unknown: number; system: number }[];
  actors: { id: string; kind: string; logged: number; writes: number; drafts: { approved: number; rejected: number }; approval_rate: number | null }[];
  highlights: {
    ai_changes: { id: string; at: string; actor: string; action: string; summary: string; why?: string; files?: string[] }[];
    decisions: { id: string; title: string; status: string; at: string; by: string }[];
    closed_issues: { id: string; title: string; days_open: number; resolution?: string; by: string }[];
  };
  attention: {
    open_issues: number;
    issue_aging: { bucket: string; count: number; by_severity: Record<string, number> }[];
    blocking_questions: { id: string; title: string; asked_by: string; assignee?: string; age_days: number }[];
    pending_approvals: { draft_id: string; kind: string; target: string; title: string; proposed_by: string; age_days: number }[];
    stale_nodes: { path: string; files: string[] }[];
    undocumented: string[];
  };
  rule_checks: {
    counts: { entries: number; decisions: number; followed: number; broken: number; not_applicable: number; unanswered: number };
    broken: { activity: RuleRow; decision: { id: string; title: string; note?: string } }[];
    unanswered: { activity: RuleRow; decisions: { id: string; title: string }[] }[];
  };
  knowledge: { nodes: number; with_code_links: number; stale: number; stale_ratio: number; undocumented: number; git: boolean };
  epics: {
    id: string;
    title: string;
    status: string;
    open: boolean;
    done: number;
    total: number;
    milestone: string | null;
    assignee: string | null;
    activity: number;
  }[];
  epics_total: number;
  milestones: {
    name: string;
    total: number;
    done: number;
    open: number;
    epics: number;
    closed_in_period: number;
    start: string;
    target: string | null;
    last_activity: string;
    overdue: boolean;
  }[];
  today: string;
}

const PRESETS = ["7d", "30d", "90d"];

// Weeks start on Monday, in the reader's own calendar; the server reads bare dates in the project's zone.
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localDay = (key: string) => new Date(`${key}T00:00:00`);
const shiftDays = (key: string, n: number) => {
  const d = localDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
};
function mondayOf(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return dayKey(x);
}

export function Reports() {
  const t = useT();
  const toast = useToast();
  const { lang } = useContext(LangContext);
  const { actors, openItem } = useSession();
  // The period is in the URL: #/reports (this week), #/reports?week=2026-09-14, #/reports?since=30d.
  const [params, setParams] = useRouteQuery();
  const thisWeek = mondayOf(new Date());
  const preset = params.get("since");
  const week = preset && PRESETS.includes(preset) ? null : (params.get("week") ?? thisWeek);
  const since = week ?? preset!;
  const until = week ? shiftDays(week, 7) : undefined;
  const [asTable, setAsTable] = useState(false);
  const { data, error, loading } = useApi<{ report: Report }>(`/api/report${qs({ since, until })}`);
  const r = data?.report;
  const hasUnknown = !!r?.totals.activity.logged.unknown;
  const weekLabel = week ? new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }).formatRange(localDay(week), localDay(shiftDays(week, 6))) : "";

  const markdown = async () => {
    const res = await fetch(apiPath(`/api/report${qs({ since, until, format: "md", lang })}`), { credentials: "same-origin" });
    return res.text();
  };
  const download = async () => {
    const blob = new Blob([await markdown()], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cortex-report-${week ? `week-${week}` : `${new Date().toISOString().slice(0, 10)}-${since}`}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(await markdown());
      toast({ text: t("rep.copied") });
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  // Locale-aware: "%40" in Turkish, "40%" in English.
  const fmtPct = (x: number) => new Intl.NumberFormat(lang, { style: "percent", maximumFractionDigits: 0 }).format(x);
  const ratio = (a: number, b: number) => (b ? fmtPct(a / b) : "—");
  // Server buckets are "0-3d", "30d+"; swap the unit for the UI language.
  const bucket = (b: string) => b.replace(/d/g, ` ${t("rep.d")}`).replace(" +", "+");

  const fmtDay = (d: string) => localDay(d).toLocaleDateString(lang, { day: "numeric", month: "short", year: "numeric" });
  const dayLabel = (row: Record<string, number | string>) =>
    new Date(`${row.date}T00:00:00Z`).toLocaleDateString(lang, { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <>
      {/* Filters: one row, above everything they scope. */}
      <div className="page-head">
        <div>
          <h1>{t("rep.title")}</h1>
          <p>{t("rep.intro")}</p>
        </div>
        <div className="page-actions">
          {week && (
            <div className="week-nav" role="group" aria-label={t("rep.week")}>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("rep.prevWeek")}
                onClick={() => setParams({ week: shiftDays(week, -7), since: undefined })}
              >
                <span className="flip">
                  <Icon name="chevron" size={16} />
                </span>
              </button>
              <span className="week-label">{weekLabel}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label={t("rep.nextWeek")}
                disabled={week >= thisWeek}
                onClick={() => setParams({ week: shiftDays(week, 7) === thisWeek ? undefined : shiftDays(week, 7), since: undefined })}
              >
                <Icon name="chevron" size={16} />
              </button>
            </div>
          )}
          <div className="segmented" role="group" aria-label={t("rep.period")}>
            <button className={week ? "on" : ""} aria-pressed={!!week} onClick={() => setParams({ since: undefined, week: undefined })}>
              {t("rep.thisWeek")}
            </button>
            {PRESETS.map((p) => (
              <button key={p} className={since === p ? "on" : ""} aria-pressed={since === p} onClick={() => setParams({ since: p, week: undefined })}>
                {parseInt(p, 10)} {t("rep.days")}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => void copy()}>
            {t("rep.copy")}
          </button>
          <button className="btn primary" onClick={() => void download()}>
            {t("rep.download")}
          </button>
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      {!r ? (
        <Loading />
      ) : (
        <div className={loading ? "is-loading" : undefined}>
          <div className="kpis">
            <Kpi
              label={t("rep.aiChanges")}
              value={r.totals.ai_logged_changes}
              sub={r.totals.ai_changes_without_why ? `${r.totals.ai_changes_without_why} ${t("rep.withoutWhy")}` : undefined}
              warn={r.totals.ai_changes_without_why > 0}
            />
            <Kpi label={t("rep.closed")} value={r.totals.items_closed.total} sub={`${r.totals.items_created.total} ${t("rep.opened")}`} />
            <Kpi
              label={t("rep.questions")}
              value={`${r.totals.questions.answered} / ${r.totals.questions.asked}`}
              sub={
                r.totals.questions.median_answer_hours !== null ? `${t("rep.median")} ${r.totals.questions.median_answer_hours} ${t("rep.hours")}` : undefined
              }
            />
            <Kpi label={t("rep.decisions")} value={r.totals.decisions.accepted} sub={`${r.totals.decisions.proposed} ${t("rep.proposed")}`} />
            <Kpi
              label={t("rep.trust")}
              value={ratio(r.totals.approvals.approved, r.totals.approvals.approved + r.totals.approvals.rejected)}
              sub={`${r.totals.approvals.approved} / ${r.totals.approvals.rejected} · ${r.totals.approvals.pending} ${t("rep.pending")}`}
            />
            <Kpi
              label={t("rep.health")}
              value={r.knowledge.git ? `${r.knowledge.stale} / ${r.knowledge.with_code_links}` : t("rep.noGit")}
              sub={r.knowledge.git && r.knowledge.with_code_links > 0 ? `${fmtPct(r.knowledge.stale_ratio)} ${t("rep.staleWord")}` : undefined}
              warn={r.knowledge.stale > 0}
            >
              {r.knowledge.git && r.knowledge.with_code_links > 0 && (
                <div className="meter" aria-hidden>
                  <span className="meter-warn" style={{ width: `${Math.round(r.knowledge.stale_ratio * 100)}%` }} />
                </div>
              )}
              <div className="sub">
                {r.knowledge.undocumented} {t("rep.undocumented")}
              </div>
            </Kpi>
          </div>

          {r.milestones.length > 0 && (
            <section className="card chart-card">
              <div className="chart-head">
                <h2>{t("rep.milestones")}</h2>
                <span className="faint text-xs">{t("rep.milestonesHint")}</span>
              </div>
              <Timeline
                rows={r.milestones.map((m) => ({
                  key: m.name,
                  label: (
                    <>
                      <span className="name" title={m.name}>
                        {m.name}
                      </span>
                      {m.overdue && (
                        <span className="chip danger" title={t("rep.overdue")}>
                          <Icon name="alert" size={12} /> {t("rep.overdue")}
                        </span>
                      )}
                    </>
                  ),
                  summary: `${m.name}: ${m.done}/${m.total} ${t("rep.msDone")}, ${m.target ? `${t("rep.target")} ${fmtDay(m.target)}` : t("rep.noTarget")}${m.overdue ? `, ${t("rep.overdue")}` : ""}`,
                  href: `#/board/task?milestone=${encodeURIComponent(m.name)}`,
                  start: m.start,
                  end: m.target ?? m.last_activity.slice(0, 10),
                  open: !m.target,
                  done: m.done,
                  total: m.total,
                  detail: (
                    <>
                      <div>
                        <b>{m.name}</b>
                      </div>
                      <div className="tip-row">
                        <b>
                          {m.done}/{m.total}
                        </b>{" "}
                        <span className="muted">{t("rep.msDone")}</span>
                      </div>
                      {m.epics > 0 && (
                        <div className="tip-row">
                          <b>{m.epics}</b> <span className="muted">{t("rep.msEpics")}</span>
                        </div>
                      )}
                      <div className="tip-row">
                        <b>{m.closed_in_period}</b> <span className="muted">{t("rep.msClosed")}</span>
                      </div>
                      <div className="faint">{m.target ? `${t("rep.target")}: ${fmtDay(m.target)}` : t("rep.noTarget")}</div>
                    </>
                  ),
                }))}
                today={r.today}
                ariaLabel={t("rep.milestones")}
                todayLabel={t("rep.today")}
                tick={(d, monthly) => localDay(d).toLocaleDateString(lang, monthly ? { month: "short" } : { day: "numeric", month: "short" })}
              />
              <div className="sr-only">
                <table className="table">
                  <caption>{t("rep.milestones")}</caption>
                  <thead>
                    <tr>
                      <th>{t("rep.milestone")}</th>
                      <th>{t("rep.msDone")}</th>
                      <th>{t("rep.target")}</th>
                      <th>{t("rep.msClosed")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.milestones.map((m) => (
                      <tr key={m.name}>
                        <td>{m.name}</td>
                        <td>
                          {m.done}/{m.total}
                        </td>
                        <td>
                          {m.target ?? t("rep.noTarget")}
                          {m.overdue ? ` (${t("rep.overdue")})` : ""}
                        </td>
                        <td>{m.closed_in_period}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <Panel title={`${t("rep.epics")}${r.epics_total ? ` (${r.epics_total})` : ""}`} empty={!r.epics.length}>
            {r.epics.map((e) => (
              <ListRow key={e.id} className="epic-row" onPress={() => openItem(e.id)}>
                <span className="title grow">{e.title}</span>
                <Progress done={e.done} total={e.total} />
                {e.milestone && <span className="chip">{e.milestone}</span>}
                <StatusChip status={e.status} />
                {e.assignee && <ActorChip id={e.assignee} actors={actors} />}
                {e.activity > 0 && (
                  <span className="faint text-xs" title={t("rep.epicActivity")}>
                    {e.activity} {t("rep.entries")}
                  </span>
                )}
              </ListRow>
            ))}
            {r.epics_total > r.epics.length && (
              <p className="faint text-xs more-note">
                +{r.epics_total - r.epics.length} {t("rep.moreEpics")}
              </p>
            )}
          </Panel>

          <div className="charts">
            <section className="card chart-card">
              <div className="chart-head">
                <h2>{t("rep.daily")}</h2>
                <div className="legend" aria-hidden>
                  <span>
                    <i className="key-ai" />
                    {t("rep.ai")} {r.totals.activity.logged.ai}
                  </span>
                  <span>
                    <i className="key-human" />
                    {t("rep.humans")} {r.totals.activity.logged.human}
                  </span>
                  {!!r.totals.activity.logged.unknown && (
                    <span>
                      <i className="key-unknown" />
                      {t("rep.unknown")} {r.totals.activity.logged.unknown}
                    </span>
                  )}
                  <span className="faint">
                    <i className="key-system" />
                    {t("rep.system")} {r.totals.activity.system.total}
                  </span>
                </div>
                <span className="spacer" />
                <label htmlFor="reports-rep-table" className="check text-xs">
                  <input id="reports-rep-table" type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} /> {t("rep.table")}
                </label>
              </div>
              {asTable ? (
                <div className="table-box">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t("rep.date")}</th>
                        <th className="num">{t("rep.ai")}</th>
                        <th className="num">{t("rep.humans")}</th>
                        {hasUnknown && <th className="num">{t("rep.unknown")}</th>}
                        <th className="num faint">{t("rep.system")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.daily.map((d) => (
                        <tr key={d.date}>
                          <td>{d.date}</td>
                          <td className="num">{d.ai}</td>
                          <td className="num">{d.human}</td>
                          {hasUnknown && <td className="num">{d.unknown}</td>}
                          <td className="num faint">{d.system}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <StackedColumns
                  data={r.daily}
                  series={[
                    { key: "ai", label: t("rep.ai"), color: "var(--viz-ai)" },
                    { key: "human", label: t("rep.humans"), color: "var(--viz-human)" },
                    // Old entries by an actor no longer in the config: neither side can claim them.
                    ...(hasUnknown ? [{ key: "unknown", label: t("rep.unknown"), color: "var(--viz-unknown)" }] : []),
                    // Audit entries run ten to thirty per logged change; drawn, they would flatten the work into the axis.
                    { key: "system", label: t("rep.system"), color: "var(--viz-system)", context: true },
                  ]}
                  xLabel={dayLabel}
                  ariaLabel={t("rep.daily")}
                />
              )}
            </section>
            <section className="card chart-card">
              <div className="chart-head">
                <h2>{t("rep.aging")}</h2>
                <span className="faint text-xs">
                  {r.attention.open_issues} {t("rep.openIssues")}
                </span>
              </div>
              <HBars
                data={r.attention.issue_aging.map((b) => ({ label: bucket(b.bucket), value: b.count }))}
                color="var(--viz-bar)"
                ariaLabel={t("rep.aging")}
                detail={(i) => {
                  const b = r.attention.issue_aging[i];
                  const sev = Object.entries(b.by_severity);
                  return (
                    <>
                      <div className="faint mb-1">{bucket(b.bucket)}</div>
                      {sev.length ? (
                        sev.map(([k, v]) => (
                          <div key={k} className="tip-row">
                            <b>{v}</b> <span className="muted">{k}</span>
                          </div>
                        ))
                      ) : (
                        <b>0</b>
                      )}
                    </>
                  );
                }}
              />
            </section>
          </div>

          <div className="cols2">
            <Panel title={t("rep.whatAi")} empty={!r.highlights.ai_changes.length}>
              {r.highlights.ai_changes.map((c) => (
                <div key={c.id} className="list-row static-row">
                  <div className="grow">
                    <div className="title">{c.summary}</div>
                    {c.why && <div className="tl-why">{c.why}</div>}
                    <div className="meta">
                      <ActorChip id={c.actor} actors={actors} />
                      <span className="chip mono">{c.action}</span>
                      {c.files?.map((f) => (
                        <span key={f} className="chip mono">
                          {f}
                        </span>
                      ))}
                      <Ago iso={c.at} />
                    </div>
                  </div>
                </div>
              ))}
            </Panel>

            <Panel
              title={t("rep.waiting")}
              empty={
                !r.attention.blocking_questions.length &&
                !r.attention.pending_approvals.length &&
                !r.attention.stale_nodes.length &&
                !r.attention.undocumented.length &&
                !r.rule_checks.broken.length &&
                !r.rule_checks.unanswered.length
              }
            >
              <Group title={t("rep.blocking")} n={r.attention.blocking_questions.length}>
                {r.attention.blocking_questions.map((q) => (
                  <ListRow key={q.id} onPress={() => openItem(q.id)}>
                    <span className="title grow">{q.title}</span>
                    <span className="chip danger">
                      {q.age_days} {t("rep.d")}
                    </span>
                  </ListRow>
                ))}
              </Group>
              <Group title={t("rep.drafts")} n={r.attention.pending_approvals.length}>
                {r.attention.pending_approvals.map((d) => (
                  <a key={d.draft_id} className="list-row plain-link" href="#/approvals">
                    <span className="title grow">{d.title}</span>
                    <ActorChip id={d.proposed_by} actors={actors} />
                    <span className="chip">
                      {d.age_days} {t("rep.d")}
                    </span>
                  </a>
                ))}
              </Group>
              <Group title={t("rep.ruleBroken")} n={r.rule_checks.broken.length}>
                {r.rule_checks.broken.map((b) => (
                  <ListRow key={`${b.activity.id}-${b.decision.id}`} onPress={() => openItem(b.decision.id)}>
                    <span className="grow">
                      <span className="title">{b.decision.title}</span>
                      <span className="faint text-xs block">
                        {b.activity.summary}
                        {b.decision.note ? ` — ${b.decision.note}` : ""}
                      </span>
                    </span>
                    <ActorChip id={b.activity.actor} actors={actors} />
                  </ListRow>
                ))}
              </Group>
              <Group title={t("rep.ruleUnanswered")} n={r.rule_checks.unanswered.length}>
                {r.rule_checks.unanswered.map((u) => (
                  <a key={u.activity.id} className="list-row plain-link" href="#/activity">
                    <span className="grow">
                      <span className="title">{u.activity.summary}</span>
                      <span className="faint text-xs block">{u.decisions.map((d) => d.title).join(" · ")}</span>
                    </span>
                    <ActorChip id={u.activity.actor} actors={actors} />
                  </a>
                ))}
              </Group>
              <Group title={t("rep.stale")} n={r.attention.stale_nodes.length}>
                {r.attention.stale_nodes.map((s) => (
                  <a key={s.path} className="list-row plain-link" href={`#/knowledge/${s.path}`}>
                    <span className="mono grow">{s.path}</span>
                    <span className="faint mono text-xs">{s.files.join(", ")}</span>
                  </a>
                ))}
              </Group>
              <Group title={t("rep.undoc")} n={r.attention.undocumented.length}>
                <div className="row gap-2 group-body">
                  {r.attention.undocumented.map((p) => (
                    <a key={p} className="chip mono" href={`#/knowledge/${p === "(root)" ? "" : p}`}>
                      {p}
                    </a>
                  ))}
                </div>
              </Group>
            </Panel>
          </div>

          <div className="cols2">
            <Panel title={t("rep.decisionsMade")} empty={!r.highlights.decisions.length}>
              {r.highlights.decisions.map((d) => (
                <ListRow key={d.id} onPress={() => openItem(d.id)}>
                  <span className="title grow">{d.title}</span>
                  <StatusChip status={d.status} />
                  <ActorChip id={d.by} actors={actors} />
                </ListRow>
              ))}
            </Panel>
            <Panel title={t("rep.closedIssues")} empty={!r.highlights.closed_issues.length}>
              {r.highlights.closed_issues.map((i) => (
                <ListRow key={i.id} onPress={() => openItem(i.id)}>
                  <span className="title grow">{i.title}</span>
                  {i.resolution && <span className="chip ok">{i.resolution}</span>}
                  <span className="faint text-xs">
                    {t("rep.openFor")} {i.days_open} {t("rep.d")}
                  </span>
                </ListRow>
              ))}
            </Panel>
          </div>

          <Panel title={t("rep.actors")} empty={!r.actors.length}>
            <div className="table-scroll" data-scroll-x role="region" aria-label={t("rep.actors")} tabIndex={0}>
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("rep.actor")}</th>
                    <th className="num">{t("rep.logged")}</th>
                    <th className="num">{t("rep.writes")}</th>
                    <th className="num">{t("rep.approvedRejected")}</th>
                    <th className="num">{t("rep.rate")}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.actors.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <ActorChip id={a.id} actors={actors} />
                      </td>
                      <td className="num">{a.logged}</td>
                      <td className="num">{a.writes}</td>
                      <td className="num">
                        {a.drafts.approved} / {a.drafts.rejected}
                      </td>
                      <td className="num">{a.approval_rate === null ? "—" : fmtPct(a.approval_rate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}

function Kpi({ label, value, sub, warn, children }: { label: string; value: number | string; sub?: string; warn?: boolean; children?: ReactNode }) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && (
        <div className={`sub ${warn ? "warn" : ""}`}>
          {warn && <Icon name="alert" size={12} />} {sub}
        </div>
      )}
      {children}
    </div>
  );
}

function Panel({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  const t = useT();
  return (
    <section className="card panel">
      <h3 className="panel-title">{title}</h3>
      {empty ? <EmptyState icon="report" title={t("rep.nothing")} card={false} /> : <div className="list">{children}</div>}
    </section>
  );
}

type RuleRow = { id: string; at: string; actor: string; summary: string };

function Group({ title, n, children }: { title: string; n: number; children: ReactNode }) {
  if (!n) return null;
  return (
    <div>
      <div className="faint group-title">
        {title} ({n})
      </div>
      {children}
    </div>
  );
}
