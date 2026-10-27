import { useEffect, useState } from "react";
import { api, qs, useApi } from "../api";
import { PatchView } from "../DiffView";
import { useT } from "../i18n";
import type { ItemSummary, KnowledgeNode, NodeSummary, StaleInfo } from "../types";
import {
  ActorChip,
  Ago,
  CommitLink,
  EmptyState,
  ErrorBox,
  Icon,
  Loading,
  Markdown,
  Modal,
  StatusChip,
  TypeChip,
  go,
  useSession,
  useToast,
  ListRow,
} from "../ui";

export function Knowledge({ path }: { path: string }) {
  const t = useT();
  const { data, error } = useApi<{ node: NodeSummary }>("/api/tree?depth=5", { on: ["node", "draft", "stale", "git"] });

  return (
    <>
      <div className="page-head">
        <h1>{t("tree.title")}</h1>
      </div>
      {error && <ErrorBox error={error} />}
      <div className="split">
        <nav className="card tree" aria-label={t("tree.title")}>
          {data ? <TreeNode node={data.node} active={path} depth={0} /> : <Loading />}
        </nav>
        <div className="card">{path !== undefined ? <NodeView path={path} /> : <EmptyState icon="tree" title={t("tree.select")} card={false} />}</div>
      </div>
    </>
  );
}

function TreeNode({ node, active, depth }: { node: NodeSummary; active: string; depth: number }) {
  const t = useT();
  const isAncestor = active === node.path || active.startsWith(node.path ? `${node.path}/` : "");
  const [open, setOpen] = useState(depth < 1 || isAncestor);
  useEffect(() => {
    if (isAncestor) setOpen(true);
  }, [isAncestor]);
  const hasKids = (node.children?.length ?? 0) > 0;
  return (
    <div>
      <div className={`tree-row ${active === node.path ? "active" : ""}`}>
        {hasKids ? (
          <button
            type="button"
            className="twisty"
            aria-expanded={open}
            aria-label={`${node.title}: ${t(open ? "tree.collapse" : "tree.expand")}`}
            onClick={() => setOpen((o) => !o)}
          >
            <span className={`twisty-icon${open ? " open" : ""}`}>
              <Icon name="chevron" size={12} />
            </span>
          </button>
        ) : (
          <span className="twisty" />
        )}
        <a className="name" href={`#/knowledge/${node.path}`} title={node.summary} aria-current={active === node.path ? "page" : undefined}>
          {node.title}
        </a>
        {node.open_items ? <span className="chip warn">{node.open_items}</span> : null}
        {node.status !== "active" && <StatusChip status={node.status} />}
      </div>
      {open && hasKids && (
        <div className="tree-children">
          {node.children!.map((c) => (
            <TreeNode key={c.path} node={c} active={active} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeView({ path }: { path: string }) {
  const t = useT();
  const { actors, ask, openItem, can } = useSession();
  const { data, error, loading, reload } = useApi<{ node: KnowledgeNode; staleness?: StaleInfo }>(`/api/node/${path}`, {
    on: ["node", "draft", "stale", "git"],
  });
  const items = useApi<{ items: ItemSummary[]; total: number }>(`/api/items${qs({ path: path || undefined, open: true, limit: 20 })}`, { on: ["item"] });
  const [editing, setEditing] = useState<"edit" | "child" | null>(null);
  const toast = useToast();

  // The server refuses when children or open items remain, and says which; we show that message.
  const remove = async (node: KnowledgeNode) => {
    if (!confirm(t("tree.confirmDelete").replace("{title}", node.title))) return;
    try {
      const r = await api<{ message: string }>(`/api/node/${node.path}`, { method: "DELETE" });
      toast({ text: r.message });
      go(`knowledge/${node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ""}`);
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  if (error)
    return (
      <div className="doc">
        <ErrorBox error={error} />
      </div>
    );
  if (loading || !data) return <Loading />;
  const n = data.node;
  const crumbs = n.path ? n.path.split("/") : [];

  return (
    <article className="doc">
      {/* Path on the left, actions on the right; the title below gets the full width. */}
      <div className="doc-bar">
        <div className="breadcrumbs">
          <a href="#/knowledge/">root</a>
          {crumbs.map((c, i) => (
            <span key={i}>
              / <a href={`#/knowledge/${crumbs.slice(0, i + 1).join("/")}`}>{c}</a>
            </span>
          ))}
        </div>
        <div className="doc-actions">
          <button className="btn sm" onClick={() => ask(n.path, n.title)}>
            <Icon name="ask" size={14} /> {t("tree.ask")}
          </button>
          {can("write_knowledge") && (
            <>
              <button className="btn sm" onClick={() => setEditing("edit")}>
                <Icon name="edit" size={14} /> {t("common.edit")}
              </button>
              <button className="btn sm" onClick={() => setEditing("child")}>
                <Icon name="plus" size={14} /> {t("tree.newChild")}
              </button>
            </>
          )}
          {n.path !== "" && can("delete_knowledge") && (
            <button className="btn sm ghost danger" onClick={() => void remove(n)} title={t("tree.delete")}>
              <Icon name="x" size={14} /> {t("tree.delete")}
            </button>
          )}
        </div>
      </div>
      <h1>{n.title}</h1>
      <p className="summary">{n.summary}</p>
      {data.staleness && <StaleBanner info={data.staleness} path={n.path} onEdit={() => setEditing("edit")} onChanged={reload} />}
      <div className="row muted text-xs gap-2 mb-4">
        <StatusChip status={n.status} />
        {t("tree.updated")} <ActorChip id={n.updated_by} actors={actors} /> · <Ago iso={n.updated_at} />
        {n.tags?.map((tag) => (
          <span key={tag} className="chip">
            #{tag}
          </span>
        ))}
      </div>
      <Markdown text={n.body} />
      {n.links?.code?.length ? (
        <div className="section">
          <h3>{t("tree.code")}</h3>
          <div className="row gap-2">
            {n.links.code.map((c) => (
              <span key={c.file} className="chip mono">
                <Icon name="file" size={12} /> {c.file}
                {c.lines ? `:${c.lines}` : ""}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {items.data && items.data.total > 0 && (
        <div className="section">
          <h3>
            {items.data.total} {t("tree.openItems")}
          </h3>
          <div className="card list">
            {items.data.items.map((i) => (
              <ListRow key={i.id} onPress={() => openItem(i.id)}>
                <TypeChip type={i.type} />
                <span className="title grow">{i.title}</span>
                <StatusChip status={i.status} />
              </ListRow>
            ))}
          </div>
        </div>
      )}
      {editing && <NodeEditor node={editing === "edit" ? n : null} parent={n.path} onClose={() => setEditing(null)} />}
    </article>
  );
}

function NodeEditor({ node, parent, onClose }: { node: KnowledgeNode | null; parent: string; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState(node?.title ?? "");
  const [summary, setSummary] = useState(node?.summary ?? "");
  const [body, setBody] = useState(node?.body ?? "");
  const [err, setErr] = useState<unknown>(null);
  const path = node ? node.path : [parent, slug].filter(Boolean).join("/");

  const save = async () => {
    setErr(null);
    try {
      const r = await api<{ message: string; path: string }>(`/api/node/${path}`, {
        method: "PUT",
        body: { title, summary, body, tags: node?.tags, links: node?.links },
      });
      toast({ text: `${t("tree.draftNote")} ${r.message}` });
      onClose();
      go(`knowledge/${r.path}`);
    } catch (e) {
      setErr(e);
    }
  };

  return (
    <Modal onClose={onClose} title={node ? t("tree.edit") : t("tree.newChild")}>
      {!node && (
        <div className="field">
          <label htmlFor="knowledge-tree-path">{t("tree.path")}</label>
          <div className="row nowrap gap-1">
            <span className="mono muted">{parent ? `${parent}/` : ""}</span>
            <input
              id="knowledge-tree-path"
              className="input mono"
              value={slug}
              placeholder="new-node"
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
            />
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="knowledge-item-title">{t("item.title")}</label>
        <input id="knowledge-item-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="knowledge-tree-summary">
          {t("tree.summary")} <span className="faint">({summary.length}/300)</span>
        </label>
        <textarea
          id="knowledge-tree-summary"
          className="textarea textarea-short"
          maxLength={300}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="knowledge-item-body">{t("item.body")}</label>
        <textarea id="knowledge-item-body" className="textarea textarea-tall" value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <ErrorBox error={err} />
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" disabled={!title.trim() || !summary.trim() || (!node && !slug)} onClick={() => void save()}>
          {t("common.save")}
        </button>
      </div>
    </Modal>
  );
}

// Used on a node's page and, one per row, on the stale knowledge page (`compact` drops the heading there).
export function StaleBanner({
  info,
  path,
  onEdit,
  onChanged,
  compact = false,
}: {
  info: StaleInfo;
  path: string;
  onEdit: () => void;
  onChanged: () => void;
  compact?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const { can, me } = useSession();
  const call = async (url: string, method: "POST" | "DELETE", done: (r: { applied?: boolean; message?: string }) => string) => {
    try {
      const r = await api<{ applied?: boolean; message?: string }>(url, { method, body: {} });
      toast({ text: done(r) });
      onChanged();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  const verify = () => call(`/api/verify/${path}`, "POST", (r) => (r.applied ? t("stale.verified") : (r.message ?? "")));
  const snooze = () => call(`/api/snooze/${path}`, "POST", () => t("stale.snoozed"));
  const wake = () => call(`/api/snooze/${path}`, "DELETE", () => t("stale.woken"));
  const [showDiff, setShowDiff] = useState(false);
  // A task for an agent, filed under this node; asking twice returns the request already open.
  const requestUpdate = async () => {
    try {
      const r = await api<{ id: string; existing: boolean }>(`/api/stale/request-update/${path}`, { method: "POST", body: {} });
      toast({ text: t(r.existing ? "stale.requestExists" : "stale.requested"), action: { label: t("stale.openTask"), run: () => go(`item/${r.id}`) } });
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  const quiet = info.severity === "low" || !!info.snoozed;
  return (
    <div className={`stale-banner${quiet ? " quiet" : ""}${compact ? " compact" : ""}`} role="status">
      <div className="row gap-2 items-start">
        {!compact && (
          <span className={`stale-icon${quiet ? " quiet" : ""}`}>
            <Icon name="alert" />
          </span>
        )}
        <div className="grow">
          {!compact && (
            <div className="row gap-2">
              <strong>{t(info.severity === "low" ? "stale.titleLow" : "stale.title")}</strong>
              <SeverityChip severity={info.severity} />
            </div>
          )}
          {info.reason === "unknown_commit" ? (
            <p className="p-sub">{t("stale.unknown")}</p>
          ) : (
            <>
              {!compact && <p className="p-sub mb-2">{t(info.severity === "low" ? "stale.bodyLow" : "stale.body")}</p>}
              <ul className="stale-list">
                {info.changes.map((c) => (
                  <li key={`${c.file}:${c.lines ?? ""}`}>
                    <span className="mono">{c.file}</span>
                    {c.lines && (
                      <span className="faint">
                        {" "}
                        ({t("stale.lines")} {c.lines})
                      </span>
                    )}{" "}
                    {c.status === "deleted" && <span className="chip danger">{t("stale.deleted")}</span>}
                    {c.status === "renamed" && (
                      <span className="chip warn">
                        {t("stale.renamed")} {c.renamed_to}
                      </span>
                    )}
                    {c.formatting_only && <span className="chip">{t("stale.formatting")}</span>}
                    {c.last && (
                      <div className="faint text-xs">
                        {c.commits} {t("stale.commits")} · <CommitLink hash={c.last.hash} /> “{c.last.subject}” — {c.last.author}, <Ago iso={c.last.date} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className="faint text-xs mt-2">
            {t("stale.verifiedAt")}: <CommitLink hash={info.verified_at_commit} />
            {info.snoozed && (
              <>
                {" · "}
                {t("stale.snoozedBy")} {info.snoozed.by}, <Ago iso={info.snoozed.at} />
              </>
            )}
          </div>
        </div>
      </div>
      {showDiff && <StaleDiff path={path} />}
      <div className="row stale-actions">
        {info.reason !== "unknown_commit" && (
          <button className="btn sm ghost" aria-expanded={showDiff} onClick={() => setShowDiff(!showDiff)}>
            {t(showDiff ? "stale.hideDiff" : "stale.showDiff")}
          </button>
        )}
        <span className="spacer" />
        {can("write_items") && (
          <button className="btn sm ghost" onClick={() => void requestUpdate()} title={t("stale.requestWhy")}>
            {t("stale.request")}
          </button>
        )}
      </div>
      {can("write_knowledge") && (
        <div className="row mt-3 justify-end">
          {me.kind === "human" &&
            (info.snoozed ? (
              <button className="btn sm ghost" onClick={() => void wake()}>
                {t("stale.wake")}
              </button>
            ) : (
              <button className="btn sm ghost" onClick={() => void snooze()} title={t("stale.snoozeWhy")}>
                {t("stale.snooze")}
              </button>
            ))}
          <button className="btn sm" onClick={() => void verify()}>
            <Icon name="check" size={14} /> {t("stale.verify")}
          </button>
          <button className="btn sm primary" onClick={onEdit}>
            <Icon name="edit" size={14} /> {t("stale.fix")}
          </button>
        </div>
      )}
    </div>
  );
}

export function SeverityChip({ severity }: { severity: StaleInfo["severity"] }) {
  const t = useT();
  return <span className={`chip sev-${severity}`}>{t(`stale.sev.${severity}`)}</span>;
}

// What the linked code went through since the node was verified, one patch per file (GET /api/stale/diff/*).
function StaleDiff({ path }: { path: string }) {
  const t = useT();
  const { data, error } = useApi<{ from: string; files: { file: string; patch: string; truncated: boolean }[]; truncated: boolean }>(
    `/api/stale/diff/${path}`,
    {
      on: ["git"],
    },
  );
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="stale-diff">
      {data.files.map((f) => (
        <section key={f.file} className="stale-diff-file">
          <h4 className="mono">{f.file}</h4>
          {f.patch ? <PatchView patch={f.patch} /> : null}
          {f.truncated && <p className="muted">{t("stale.diffCut")}</p>}
        </section>
      ))}
      {data.files.length === 0 && <p className="muted">{t("stale.diffEmpty")}</p>}
    </div>
  );
}
