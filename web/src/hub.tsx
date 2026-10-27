import type { FormEvent, ReactNode } from "react";
import { useContext, useState } from "react";
import { ApiError, api, currentProject, qs, useApi } from "./api";
import { LangContext, useLabels, useT } from "./i18n";
import type { Key } from "./i18n";
import type { HubMe } from "./types";
import { HBars, StackedColumns } from "./charts";
import { BackupsPanel } from "./backups";
import { Ago, EmptyState, ErrorBox, Icon, Loading, Modal, PageGate, useRoute, useToast } from "./ui";

// Screens of the team server (hub): sign-in, invites, the project list, organization admin and project members.

const HUMAN_ROLES = ["owner", "admin", "member", "viewer"];
const AI_ROLES = ["reader", "contributor", "trusted"];

export function Brand({ sub }: { sub?: string }) {
  return (
    <span className="brand">
      <span className="brand-mark">
        <Icon name="activity" size={14} />
      </span>
      Cortex {sub && <small>· {sub}</small>}
    </span>
  );
}

// ---- sign in -------------------------------------------------------------------------

export function HubLogin({ org }: { org?: string }) {
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password } });
      location.reload();
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };
  return (
    <AuthCard title={t("hub.signIn")} sub={org}>
      <form onSubmit={(e) => void submit(e)}>
        <ErrorBox error={err} />
        <div className="field">
          <label htmlFor="email">{t("hub.email")}</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t("hub.password")}</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn primary wide" disabled={busy || !email || !password}>
          {busy ? t("hub.signingIn") : t("hub.signIn")}
        </button>
        <p className="auth-foot">{t("hub.forgot")}</p>
      </form>
    </AuthCard>
  );
}

export function InvitePage({ token }: { token: string }) {
  const t = useT();
  const info = useApi<{ email: string; name: string; org: string }>(`/api/auth/invite/${encodeURIComponent(token)}`);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (password !== repeat) return setErr(new ApiError(400, "mismatch", t("hub.passwordMismatch")));
    setBusy(true);
    try {
      await api(`/api/auth/invite/${encodeURIComponent(token)}`, { method: "POST", body: { password } });
      location.href = "/";
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };
  if (info.loading) return <Loading />;
  if (info.error || !info.data)
    return (
      <AuthCard title={t("hub.inviteTitle")}>
        <p className="muted">{t("hub.inviteExpired")}</p>
      </AuthCard>
    );
  return (
    <AuthCard title={t("hub.inviteTitle")} sub={info.data.org}>
      <p className="muted lead-tight">
        {info.data.name} · {info.data.email}
      </p>
      <p className="muted">{t("hub.inviteBody")}</p>
      <form onSubmit={(e) => void submit(e)}>
        <ErrorBox error={err} />
        <input type="email" autoComplete="username" value={info.data.email} readOnly hidden />
        <div className="field">
          <label htmlFor="pw">{t("hub.password")}</label>
          <input
            id="pw"
            className="input"
            type="password"
            autoComplete="new-password"
            autoFocus
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="hint">{t("hub.passwordHint")}</span>
        </div>
        <div className="field">
          <label htmlFor="pw2">{t("hub.passwordRepeat")}</label>
          <input id="pw2" className="input" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </div>
        <button className="btn primary wide" disabled={busy || password.length < 10}>
          {t("hub.continue")}
        </button>
      </form>
    </AuthCard>
  );
}

function AuthCard({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand sub={sub} />
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

// ---- hub frame: projects home and organization admin ------------------------------------------

export function useHubMe() {
  return useApi<HubMe>("/api/hub/me");
}

export function UserMenu({ me }: { me: HubMe }) {
  const t = useT();
  const { lang, setLang } = useContext(LangContext);
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState(false);
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.href = "/";
  };
  const initials = me.principal.name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="menu-wrap">
      <button className="avatar-btn" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={me.principal.name}>
        {initials}
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="menu" role="menu">
            <div className="menu-head">
              <strong>{me.principal.name}</strong>
              <span className="faint">{me.principal.email}</span>
            </div>
            <a className="menu-item" href="/" role="menuitem">
              <Icon name="board" size={15} /> {t("hub.projects")}
            </a>
            {me.principal.org_admin && (
              <a className="menu-item" href="/admin/#/users" role="menuitem">
                <Icon name="rules" size={15} /> {t("hub.organization")}
              </a>
            )}
            <button
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setKeys(true);
              }}
            >
              <Icon name="chat" size={15} /> {t("via.keys")}
            </button>
            <button className="menu-item" role="menuitem" onClick={() => setLang(lang === "tr" ? "en" : "tr")}>
              <Icon name="globe" size={15} /> {t("lang.toggle")}
            </button>
            <button className="menu-item" role="menuitem" onClick={() => void signOut()}>
              <Icon name="logout" size={15} /> {t("hub.signOut")}
            </button>
          </div>
        </>
      )}
      {keys && <ChatKeys me={me} onClose={() => setKeys(false)} />}
    </div>
  );
}

type ChatKey = { id: string; project_id: string; label: string; created_at: string; last_used_at: string | null };
type Connection = { id: string; project_id: string; agent_id: string; client: string; created_at: string; last_used_at: string | null };

// A person's keys for approving from their AI chat: one project each, their own role, read and record answers only.
function ChatKeys({ me, onClose }: { me: HubMe; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const { data, error, reload } = useApi<{ tokens: ChatKey[] }>("/api/hub/chat-tokens");
  // AI apps the person let in through OAuth (claude.ai connectors): listed here so they can be ended.
  const conns = useApi<{ connections: Connection[] }>("/api/hub/connections");
  const [project, setProject] = useState(currentProject() ?? me.projects[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState<{ value: string; project: string } | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await api<{ secret: string }>("/api/hub/chat-tokens", { method: "POST", body: { project, label } });
      setSecret({ value: r.secret, project });
      setLabel("");
      reload();
    } catch (err) {
      toast({ text: (err as Error).message, error: true });
    }
  };
  const revoke = async (id: string) => {
    await api(`/api/hub/chat-tokens/${id}`, { method: "DELETE" }).catch((err: Error) => toast({ text: err.message, error: true }));
    reload();
  };
  const disconnect = async (id: string) => {
    await api(`/api/hub/connections/${id}`, { method: "DELETE" }).catch((err: Error) => toast({ text: err.message, error: true }));
    conns.reload();
  };
  if (secret)
    return (
      <Secret
        title={t("via.keyCreated")}
        value={secret.value}
        hint={t("via.keyHint")}
        onClose={() => setSecret(null)}
        connect={{ project: secret.project, chat: true }}
      />
    );
  const name = (id: string) => me.projects.find((p) => p.id === id)?.name ?? id;
  return (
    <Modal onClose={onClose} title={t("via.keys")}>
      <p className="muted mt-0">{t("via.keysIntro")}</p>
      <ErrorBox error={error} />
      {data?.tokens.map((k) => (
        <div key={k.id} className="key-row">
          <strong>{k.label}</strong>
          <span className="chip">{name(k.project_id)}</span>
          <span className="faint">
            {k.last_used_at ? (
              <>
                {t("via.keyLastUsed")} <Ago iso={k.last_used_at} />
              </>
            ) : (
              t("via.keyNever")
            )}
          </span>
          <button className="btn sm danger" onClick={() => void revoke(k.id)}>
            {t("via.revoke")}
          </button>
        </div>
      ))}
      <form className="key-row" onSubmit={(e) => void create(e)}>
        <select className="select" value={project} onChange={(e) => setProject(e.target.value)} aria-label="project">
          {me.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("via.keyLabel")}
          aria-label={t("via.keyLabel")}
          maxLength={80}
        />
        <button className="btn primary" type="submit" disabled={!project}>
          {t("via.keyNew")}
        </button>
      </form>
      {!!conns.data?.connections.length && (
        <>
          <h4>{t("via.connections")}</h4>
          {conns.data.connections.map((c) => (
            <div key={c.id} className="key-row">
              <strong>{c.client}</strong>
              <span className="chip">{name(c.project_id)}</span>
              <span className="chip">{c.agent_id}</span>
              <span className="faint">
                {c.last_used_at ? (
                  <>
                    {t("via.keyLastUsed")} <Ago iso={c.last_used_at} />
                  </>
                ) : (
                  t("via.keyNever")
                )}
              </span>
              <button className="btn sm danger" onClick={() => void disconnect(c.id)}>
                {t("via.disconnect")}
              </button>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}

// Project picker for the top bar of a project board.
export function ProjectSwitcher({ me }: { me: HubMe }) {
  const current = currentProject();
  return (
    <select
      className="select project-switch"
      value={current ?? ""}
      onChange={(e) => (location.href = `/p/${encodeURIComponent(e.target.value)}/#/inbox`)}
      aria-label="project"
    >
      {me.projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

export function HubFrame({ me, children }: { me: HubMe; children: ReactNode }) {
  return (
    <div className="hub">
      <header className="topbar">
        <a href="/" className="plain-link">
          <Brand sub={me.org} />
        </a>
        <div className="topbar-right">
          <UserMenu me={me} />
        </div>
      </header>
      <main className="hub-main">
        <PageGate key={location.hash.split("?")[0]}>{children}</PageGate>
      </main>
    </div>
  );
}

export function HubHome({ me }: { me: HubMe }) {
  const t = useT();
  const label = useLabels();
  return (
    <HubFrame me={me}>
      <div className="page-head">
        <h1>{t("hub.projects")}</h1>
        <span className="spacer" />
        {me.principal.org_admin && (
          <a className="btn" href="/admin/#/projects">
            <Icon name="plus" /> {t("hub.addProject")}
          </a>
        )}
      </div>
      {me.projects.length === 0 ? (
        <EmptyState icon="board" title={t("hub.noProjects")} />
      ) : (
        <div className="project-grid">
          {me.projects.map((p) => (
            <a key={p.id} className="card project-card" href={`/p/${encodeURIComponent(p.id)}/#/inbox`}>
              <span className="project-icon">{p.name.slice(0, 1).toUpperCase()}</span>
              <span className="project-name">{p.name}</span>
              <span className="faint">{label.role(p.role)}</span>
            </a>
          ))}
        </div>
      )}
    </HubFrame>
  );
}

// ---- organization admin --------------------------------------------------------------------

type AdminUser = {
  id: string;
  email: string;
  name: string;
  org_admin: boolean;
  disabled: boolean;
  has_password: boolean;
  projects: { id: string; role: string }[];
};
type AdminAgent = { id: string; name: string; disabled: boolean; projects: { id: string; role: string }[] };
type PullResult = { at: string; status: "pulled" | "up_to_date" | "skipped" | "failed"; message: string; behind?: number; ahead?: number; pending?: number };
type AdminProject = {
  id: string;
  name: string;
  path: string;
  members: number;
  exists: boolean;
  knowledge: "hub" | "repo" | null;
  linked: string[];
  pull: PullResult | null;
};

export function AdminPage({ me }: { me: HubMe }) {
  const t = useT();
  const route = useRoute();
  const tab = route[0] === "agents" || route[0] === "projects" || route[0] === "usage" || route[0] === "backups" ? route[0] : "users";
  return (
    <HubFrame me={me}>
      <div className="page-head">
        <h1>{t("hub.organization")}</h1>
        <span className="spacer" />
        <div className="segmented" role="tablist">
          {(["users", "agents", "projects", "backups", "usage"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => (location.hash = `#/${k}`)}>
              {t(
                k === "users"
                  ? "hub.users"
                  : k === "agents"
                    ? "hub.agents"
                    : k === "projects"
                      ? "hub.projects"
                      : k === "backups"
                        ? "backup.title"
                        : "usage.title",
              )}
            </button>
          ))}
        </div>
      </div>
      {tab === "users" && <UsersTab me={me} />}
      {tab === "agents" && <AgentsTab />}
      {tab === "projects" && <ProjectsTab />}
      {tab === "backups" && <BackupsPanel base="/api/admin/backup" kind="hub" />}
      {tab === "usage" && <UsageTab />}
    </HubFrame>
  );
}

function useProjectsList() {
  return useApi<{ projects: AdminProject[]; pull_minutes: number }>("/api/admin/projects");
}

// A secret shown once. With `connect`, the dialog also lays out how to connect an AI to the hub with it: ready-made
// commands per system with the hub's address filled in. The secret is an agent token, or with `chat` a person's
// chat key (then the agent's token is pasted into the guide, and the key's project is fixed).
function Secret({
  title,
  value,
  hint,
  onClose,
  connect,
}: {
  title: string;
  value: string;
  hint: string;
  onClose: () => void;
  connect?: { project?: string; chat?: boolean };
}) {
  const t = useT();
  const toast = useToast();
  return (
    <Modal onClose={onClose} title={title}>
      <p className="muted mt-0">{hint}</p>
      <div className="secret">
        <code>{value}</code>
        <button
          className="btn sm"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => toast({ text: t("hub.copied") }));
          }}
        >
          {t("hub.copy")}
        </button>
      </div>
      {connect && (connect.chat ? <ConnectGuide chatKey={value} project={connect.project} /> : <ConnectGuide token={value} project={connect.project} />)}
      <div className="modal-foot">
        <button className="btn primary" onClick={onClose}>
          {t("hub.done")}
        </button>
      </div>
    </Modal>
  );
}

type ConnectOs = "unix" | "windows";
// The AI tools the guide writes a ready setup for. All run the same MCP server; they differ in where the
// setup goes (a command, a TOML or JSON file, a settings screen). "http": tools that only connect to a URL.
// Claude and ChatGPT apps take only a URL and sign in with OAuth: they have their own section (AppConnect).
const CONNECT_TOOLS = ["claude", "codex", "cursor", "antigravity", "opencode", "http"] as const;
type ConnectTool = (typeof CONNECT_TOOLS)[number];

// How a person connects their AI (Claude Code) to a project on this hub, step by step, with commands they can
// paste as they are. The hub's own address comes from the server (public_url) and can be edited here, e.g.
// when the hub is reached through a tunnel. Task 01M3NP8XVMSKZKAM94VG14CN7B.
// Opened with an agent token (a new agent, a new token) or with a chat key (approve from the AI chat). The other
// secret is made right here with one button (my chat key for this project; a new token for one of the
// project's agents) or pasted, so one dialog gives the whole command. What is pasted stays in this page.
export function ConnectGuide({ token, chatKey, project }: { token?: string; chatKey?: string; project?: string }) {
  const t = useT();
  const toast = useToast();
  const me = useHubMe();
  const projects = me.data?.projects ?? [];
  const [url, setUrl] = useState<string | null>(null);
  const [pick, setPick] = useState(project ?? "");
  const [os, setOs] = useState<ConnectOs>(() => (/win/i.test(navigator.userAgent) ? "windows" : "unix"));
  const [tool, setTool] = useState<ConnectTool>("claude");
  const [agentToken, setAgentToken] = useState("");
  const [humanKey, setHumanKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [rotateId, setRotateId] = useState("");
  const forChat = chatKey !== undefined;
  const hubUrl = (url ?? me.data?.hub_url ?? location.origin).replace(/\/+$/, "");
  // With several projects nothing is picked for the person: a command for the wrong project connects silently
  // and writes there (issue 01M3P46RC52ACJ0TYPCBE3G13A). One project is the only choice, so it is taken.
  const proj = pick || (projects.length === 1 ? projects[0].id : "");
  const agent = token ?? (agentToken.trim() || t("connect.agentTokenPlaceholder"));
  const human = chatKey ?? humanKey.trim();
  const args = ["mcp", "--hub", hubUrl, "--project", proj, "--token", agent, ...(human ? ["--human-token", human] : [])];
  // On Windows npx is a .cmd script: tools that start a process without a shell need cmd /c in front.
  const launch =
    os === "windows" ? { command: "cmd", args: ["/c", "npx", "-y", "cortexboard", ...args] } : { command: "npx", args: ["-y", "cortexboard", ...args] };
  const mcpUrl = `${hubUrl}/mcp/p/${encodeURIComponent(proj)}`;
  const cmd = connectSetup(tool, launch, { url: mcpUrl, token: agent, human });
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast({ text: t("hub.copied") }),
      () => toast({ text: t("connect.copyFailed"), error: true }),
    );
  // The project's agents, to make a new token for one when the old one is lost (chat key dialog only).
  const members = useApi<{ members: { principal: string; kind: string; name: string }[] }>(
    forChat && proj ? `/api/p/${encodeURIComponent(proj)}/members` : null,
  );
  const aiMembers = (members.data?.members ?? []).filter((m) => m.kind === "ai");
  const agentPick = rotateId || aiMembers[0]?.principal || "";
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };
  // My chat key for this project, made here: approvals asked in the chat are recorded as me.
  const makeKey = () =>
    run(async () => {
      const r = await api<{ secret: string }>("/api/hub/chat-tokens", { method: "POST", body: { project: proj, label: "Claude Code" } });
      setHumanKey(r.secret);
      toast({ text: t("connect.chatKeyMade") });
    });
  // A new token for one of the project's agents; the old one stops working wherever it is used.
  const rotate = () => {
    if (!agentPick || !confirm(t("connect.rotateConfirm").replace("{id}", agentPick))) return;
    void run(async () => {
      const r = await api<{ token: string }>(`/api/p/${encodeURIComponent(proj)}/agents/${encodeURIComponent(agentPick)}/token`, { method: "POST" });
      setAgentToken(r.token);
      toast({ text: t("connect.rotated") });
    });
  };
  // Password managers take a text box on a page with secrets for a sign-in form.
  const noFill = { autoComplete: "off", "data-1p-ignore": true, "data-lpignore": "true", spellCheck: false } as const;
  return (
    <section className="connect" aria-labelledby="connect-title">
      <h3 id="connect-title">{t(forChat ? "connect.chatTitle" : "connect.title")}</h3>
      <div className="grid2">
        <div className="field">
          <label htmlFor="connect-project">{t("connect.project")}</label>
          <select
            id="connect-project"
            className="select"
            value={proj}
            onChange={(e) => setPick(e.target.value)}
            disabled={!projects.length || forChat /* a chat key belongs to one project */}
          >
            {!proj ? <option value="">{t("connect.pickProject")}</option> : !projects.some((p) => p.id === proj) && <option value={proj}>{proj}</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="connect-url">{t("connect.url")}</label>
          <input id="connect-url" className="input mono" value={hubUrl} onChange={(e) => setUrl(e.target.value)} />
          <span className="hint">{t("connect.urlHint")}</span>
        </div>
      </div>
      <AppConnect url={proj ? mcpUrl : ""} copy={copy} />
      <h4 className="connect-sub">{t("connect.cmdTitle")}</h4>
      {forChat ? (
        <div className="field">
          <label htmlFor="connect-agent-token">{t("connect.agentToken")}</label>
          <input
            id="connect-agent-token"
            className="input mono"
            type="password"
            {...noFill}
            autoComplete="new-password"
            value={agentToken}
            onChange={(e) => setAgentToken(e.target.value)}
            placeholder="ctx_…"
          />
          <span className="hint">{t("connect.agentTokenHint")}</span>
          {aiMembers.length ? (
            <div className="connect-inline">
              <span className="hint">{t("connect.lostToken")}</span>
              {aiMembers.length > 1 && (
                <select className="select" aria-label={t("connect.agent")} value={agentPick} onChange={(e) => setRotateId(e.target.value)}>
                  {aiMembers.map((m) => (
                    <option key={m.principal} value={m.principal}>
                      {m.name} ({m.principal})
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="btn sm" disabled={busy} onClick={rotate}>
                {aiMembers.length > 1 ? t("connect.rotate") : t("connect.rotateOne").replace("{id}", agentPick)}
              </button>
            </div>
          ) : (
            members.data && <span className="hint">{t("connect.noAgents")}</span>
          )}
        </div>
      ) : (
        <div className="field">
          <label htmlFor="connect-chat-key">{t("connect.chatKey")}</label>
          <div className="connect-inline">
            {humanKey ? (
              <>
                <span className="chip ok">{t("connect.chatKeyAdded")}</span>
                <button type="button" className="btn sm ghost" onClick={() => setHumanKey("")}>
                  {t("connect.chatKeyRemove")}
                </button>
              </>
            ) : (
              <button type="button" className="btn sm" disabled={busy || !proj} onClick={() => void makeKey()}>
                {t("connect.chatKeyMake")}
              </button>
            )}
          </div>
          <span className="hint">{t("connect.chatKeyHint")}</span>
          <details className="connect-paste">
            <summary>{t("connect.chatKeyPaste")}</summary>
            <input
              id="connect-chat-key"
              className="input mono"
              type="password"
              {...noFill}
              autoComplete="new-password"
              value={humanKey}
              onChange={(e) => setHumanKey(e.target.value)}
              placeholder="chat_…"
              aria-label={t("connect.chatKey")}
            />
          </details>
        </div>
      )}
      <ol className="connect-steps">
        <li>
          <b>{t("connect.step1")}</b> {t("connect.step1Body")} <code>node -v</code>
        </li>
        <li>
          <b>{t("connect.step2")}</b> {t("connect.step2Body")}
          <div className="connect-inline">
            <select className="select" aria-label={t("connect.tool")} value={tool} onChange={(e) => setTool(e.target.value as ConnectTool)}>
              {CONNECT_TOOLS.map((k) => (
                <option key={k} value={k}>
                  {t(`connect.tool.${k}`)}
                </option>
              ))}
            </select>
            {tool !== "http" && (
              <div className="segmented" role="tablist" aria-label={t("connect.system")}>
                {(["unix", "windows"] as const).map((k) => (
                  <button key={k} role="tab" aria-selected={os === k} className={os === k ? "on" : ""} onClick={() => setOs(k)}>
                    {t(k === "unix" ? "connect.unix" : "connect.windows")}
                  </button>
                ))}
              </div>
            )}
            <details className="connect-help">
              <summary className="btn sm">
                <Icon name="ask" size={14} /> {t("connect.howto")}
              </summary>
              <ol>
                {t(`connect.howto.${tool}`)
                  .split("\n")
                  .map((line) => (
                    <li key={line}>{line}</li>
                  ))}
              </ol>
            </details>
          </div>
          {tool === "claude" && (
            <p className="hint connect-replace">
              {t("connect.replaceHint")} <code>claude mcp remove cortex</code>
            </p>
          )}
          {proj ? (
            <div className="secret connect-cmd">
              <pre>
                <code>{cmd}</code>
              </pre>
              <button className="btn sm" onClick={() => copy(cmd)}>
                {t("hub.copy")}
              </button>
            </div>
          ) : (
            <p className="hint danger">{t("connect.pickProjectFirst")}</p>
          )}
          {proj && forChat && !agentToken.trim() && <span className="hint danger">{t("connect.agentTokenMissing")}</span>}
          <span className="hint">{t(tool === "claude" ? "connect.cmdHint" : tool === "http" ? "connect.httpHint" : "connect.jsonHint")}</span>
        </li>
        <li>
          <b>{t("connect.step3")}</b>{" "}
          {t(tool === "claude" ? (human ? "connect.step3BodyChat" : "connect.step3Body") : human ? "connect.step3AnyChat" : "connect.step3Any")}
        </li>
      </ol>
      <p className="faint fine-print">{t(forChat ? "connect.chatWarning" : "connect.warning")}</p>
    </section>
  );
}

// Claude and ChatGPT apps (and claude.ai): only the address, the app signs in on the hub with OAuth and the
// person picks the agent there (src/hub/oauth.ts). No token, so it comes first: it is the easiest way in.
const APPS = ["claude", "chatgpt"] as const;
function AppConnect({ url, copy }: { url: string; copy: (text: string) => void }) {
  const t = useT();
  const [app, setApp] = useState<(typeof APPS)[number]>("claude");
  return (
    <div className="connect-app">
      <div className="connect-inline">
        <h4>{t("connect.appTitle")}</h4>
        <span className="chip ok">{t("connect.appNoToken")}</span>
        <span className="spacer" />
        <div className="segmented" role="tablist" aria-label={t("connect.appTitle")}>
          {APPS.map((k) => (
            <button key={k} role="tab" aria-selected={app === k} className={app === k ? "on" : ""} onClick={() => setApp(k)}>
              {t(`connect.app.${k}`)}
            </button>
          ))}
        </div>
      </div>
      <ol className="connect-app-steps">
        {t(`connect.appSteps.${app}`)
          .split("\n")
          .map((line) => (
            <li key={line}>{line}</li>
          ))}
      </ol>
      {url ? (
        <div className="secret connect-url">
          <code>{url}</code>
          <button className="btn sm" onClick={() => copy(url)}>
            {t("hub.copy")}
          </button>
        </div>
      ) : (
        <p className="hint danger">{t("connect.pickProjectFirst")}</p>
      )}
      <p className="hint">{t("connect.appNote")}</p>
    </div>
  );
}

// The setup text for one tool: what the person pastes, as the tool expects it.
function connectSetup(tool: ConnectTool, launch: { command: string; args: string[] }, remote: { url: string; token: string; human?: string }): string {
  const q = (v: string) => JSON.stringify(v); // TOML basic strings take the same escapes as JSON
  switch (tool) {
    case "claude":
      return `claude mcp add cortex -- ${[launch.command, ...launch.args].join(" ")}`;
    case "codex":
      return `[mcp_servers.cortex]\ncommand = ${q(launch.command)}\nargs = [${launch.args.map(q).join(", ")}]`;
    case "opencode":
      return JSON.stringify(
        { $schema: "https://opencode.ai/config.json", mcp: { cortex: { type: "local", command: [launch.command, ...launch.args], enabled: true } } },
        null,
        2,
      );
    case "http":
      // The chat key as a second header: approvals come as questions on the board (HTTP cannot ask in the chat).
      return `URL: ${remote.url}\nAuthorization: Bearer ${remote.token}${remote.human ? `\nX-Cortex-Human-Token: ${remote.human}` : ""}`;
    default: // Cursor, Antigravity and most other tools read the same mcpServers JSON
      return JSON.stringify({ mcpServers: { cortex: launch } }, null, 2);
  }
}

function UsersTab({ me }: { me: HubMe }) {
  const t = useT();
  const label = useLabels();
  const toast = useToast();
  const users = useApi<{ users: AdminUser[] }>("/api/admin/users");
  const projects = useProjectsList();
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      users.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  const newLink = (u: AdminUser) =>
    act(async () => setSecret((await api<{ invite_url: string }>(`/api/admin/users/${u.id}/invite`, { method: "POST" })).invite_url));
  const patch = (u: AdminUser, body: object) => act(() => api(`/api/admin/users/${u.id}`, { method: "PATCH", body }));

  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {t("hub.addUser")}
        </button>
      </div>
      {users.error && <ErrorBox error={users.error} />}
      {!users.data ? (
        <Loading />
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t("hub.name")}</th>
                <th>{t("hub.projects")}</th>
                <th>{t("hub.status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="cell-title">
                      {u.name} {u.org_admin && <span className="chip accent">{t("hub.orgAdmin")}</span>}
                    </div>
                    <div className="faint">{u.email}</div>
                  </td>
                  <td className="muted">{u.projects.map((p) => `${p.id} · ${label.role(p.role)}`).join(", ") || "—"}</td>
                  <td>
                    {u.disabled ? (
                      <span className="chip danger">{t("hub.disabled")}</span>
                    ) : u.has_password ? (
                      <span className="chip ok">{t("hub.active")}</span>
                    ) : (
                      <span className="chip warn">{t("hub.pending")}</span>
                    )}
                  </td>
                  <td className="actions">
                    <button className="btn sm" onClick={() => void newLink(u)}>
                      {t("hub.newLink")}
                    </button>
                    {u.id !== me.principal.id && (
                      <>
                        <button className="btn sm ghost" onClick={() => void patch(u, { org_admin: !u.org_admin })}>
                          {u.org_admin ? t("hub.removeAdmin") : t("hub.makeAdmin")}
                        </button>
                        <button className={`btn sm ghost ${u.disabled ? "" : "danger"}`} onClick={() => void patch(u, { disabled: !u.disabled })}>
                          {u.disabled ? t("hub.enable") : t("hub.disable")}
                        </button>
                        <button
                          className="btn sm ghost danger"
                          onClick={() =>
                            confirm(t("hub.deleteUserConfirm").replace("{name}", u.name)) &&
                            void act(() => api(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: "DELETE" }))
                          }
                        >
                          {t("hub.delete")}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <AddPrincipal
          kind="human"
          projects={projects.data?.projects ?? []}
          onClose={() => setAdding(false)}
          onDone={(value) => {
            setAdding(false);
            setSecret(value);
            users.reload();
          }}
        />
      )}
      {secret && <Secret title={t("hub.inviteLink")} value={secret} hint={t("hub.inviteLinkHint")} onClose={() => setSecret(null)} />}
    </>
  );
}

function AgentsTab() {
  const t = useT();
  const label = useLabels();
  const toast = useToast();
  const agents = useApi<{ agents: AdminAgent[] }>("/api/admin/agents");
  const projects = useProjectsList();
  const [adding, setAdding] = useState(false);
  // The guide opens on the agent's project when it has one; with several the person picks.
  const [secret, setSecret] = useState<{ value: string; project?: string } | null>(null);
  const only = (a: AdminAgent) => (a.projects.length === 1 ? a.projects[0].id : undefined);
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      agents.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  return (
    <>
      <div className="toolbar">
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {t("hub.addAgent")}
        </button>
      </div>
      {!agents.data ? (
        <Loading />
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t("hub.name")}</th>
                <th>{t("hub.projects")}</th>
                <th>{t("hub.status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.data.agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div className="cell-title">{a.name}</div>
                    <div className="faint mono">{a.id}</div>
                  </td>
                  <td className="muted">{a.projects.map((p) => `${p.id} · ${label.role(p.role)}`).join(", ") || "—"}</td>
                  <td>{a.disabled ? <span className="chip danger">{t("hub.disabled")}</span> : <span className="chip ok">{t("hub.active")}</span>}</td>
                  <td className="actions">
                    <button
                      className="btn sm"
                      onClick={() =>
                        void act(async () =>
                          setSecret({ value: (await api<{ token: string }>(`/api/admin/agents/${a.id}/token`, { method: "POST" })).token, project: only(a) }),
                        )
                      }
                    >
                      {t("hub.rotate")}
                    </button>
                    <button
                      className={`btn sm ghost ${a.disabled ? "" : "danger"}`}
                      onClick={() => void act(() => api(`/api/admin/agents/${a.id}`, { method: "PATCH", body: { disabled: !a.disabled } }))}
                    >
                      {a.disabled ? t("hub.enable") : t("hub.disable")}
                    </button>
                    <button
                      className="btn sm ghost danger"
                      onClick={() =>
                        confirm(t("hub.deleteAgentConfirm").replace("{name}", a.name)) &&
                        void act(() => api(`/api/admin/agents/${encodeURIComponent(a.id)}`, { method: "DELETE" }))
                      }
                    >
                      {t("hub.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {agents.data.agents.length === 0 && <EmptyState icon="user" title={t("hub.agents")} card={false} />}
        </div>
      )}
      {adding && (
        <AddPrincipal
          kind="ai"
          projects={projects.data?.projects ?? []}
          onClose={() => setAdding(false)}
          onDone={(value, project) => {
            setAdding(false);
            setSecret({ value, project });
            agents.reload();
          }}
        />
      )}
      <DisconnectHelp />
      {secret && (
        <Secret title={t("hub.token")} value={secret.value} hint={t("hub.tokenHint")} onClose={() => setSecret(null)} connect={{ project: secret.project }} />
      )}
    </>
  );
}

// Taking Cortex out of Claude Code on a computer: before connecting it again (another project, another hub) or
// when an agent is no longer used there. The token is stopped here (Disable / Delete), the entry there.
function DisconnectHelp() {
  const t = useT();
  const toast = useToast();
  const steps = [
    { label: t("disconnect.step1"), cmd: "claude mcp list" },
    { label: t("disconnect.step2"), cmd: "claude mcp remove cortex" },
    { label: t("disconnect.step3"), cmd: "claude mcp remove cortex -s local" },
  ];
  const copy = (text: string) =>
    void navigator.clipboard.writeText(text).then(
      () => toast({ text: t("hub.copied") }),
      () => toast({ text: t("connect.copyFailed"), error: true }),
    );
  return (
    <details className="card disconnect">
      <summary>
        <span className="disconnect-chevron" aria-hidden="true">
          <Icon name="chevron" size={14} />
        </span>
        <span className="disconnect-head">
          <span className="disconnect-title">{t("disconnect.title")}</span>
          <span className="disconnect-sub">{t("disconnect.sub")}</span>
        </span>
      </summary>
      <div className="disconnect-body">
        <p className="disconnect-note">{t("disconnect.body")}</p>
        <ol className="disconnect-steps">
          {steps.map((s, i) => (
            <li key={s.cmd}>
              <span className="disconnect-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="disconnect-label">{s.label}</span>
              <code>{s.cmd}</code>
              <button className="btn sm ghost" onClick={() => copy(s.cmd)} aria-label={`${t("hub.copy")}: ${s.cmd}`}>
                {t("hub.copy")}
              </button>
            </li>
          ))}
        </ol>
        <p className="disconnect-note">{t("disconnect.scopeHint")}</p>
        <p className="disconnect-note">
          <Icon name="lock" size={13} /> {t("disconnect.tokenHint")}
        </p>
      </div>
    </details>
  );
}

function AddPrincipal({
  kind,
  projects,
  onClose,
  onDone,
}: {
  kind: "human" | "ai";
  projects: AdminProject[];
  onClose: () => void;
  onDone: (secret: string, project?: string) => void;
}) {
  const t = useT();
  const label = useLabels();
  const [a, setA] = useState(""); // email or agent id
  const [name, setName] = useState("");
  const [orgAdmin, setOrgAdmin] = useState(false);
  const [project, setProject] = useState("");
  const roles = kind === "human" ? HUMAN_ROLES : AI_ROLES;
  const [role, setRole] = useState(kind === "human" ? "member" : "trusted");
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try {
      const projectsBody = project ? [{ id: project, role }] : [];
      if (kind === "human") {
        const r = await api<{ invite_url: string }>("/api/admin/users", {
          method: "POST",
          body: { email: a, name, org_admin: orgAdmin, projects: projectsBody },
        });
        onDone(r.invite_url);
      } else {
        const r = await api<{ token: string }>("/api/admin/agents", { method: "POST", body: { id: a, name, projects: projectsBody } });
        onDone(r.token, project || undefined);
      }
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal onClose={onClose} title={t(kind === "human" ? "hub.addUser" : "hub.addAgent")}>
      <ErrorBox error={err} />
      <div className="field">
        <label htmlFor="hub-who">{t(kind === "human" ? "hub.email" : "hub.agentId")}</label>
        <input id="hub-who" className="input" autoFocus value={a} onChange={(e) => setA(e.target.value)} type={kind === "human" ? "email" : "text"} />
        {kind === "ai" && <span className="hint">{t("hub.agentIdHint")}</span>}
      </div>
      <div className="field">
        <label htmlFor="hub-hub-name">{t("hub.name")}</label>
        <input id="hub-hub-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="hub-hub-firstproject">{t("hub.firstProject")}</label>
          <select id="hub-hub-firstproject" className="select" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">—</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="hub-hub-role">{t("hub.role")}</label>
          <select id="hub-hub-role" className="select" value={role} onChange={(e) => setRole(e.target.value)} disabled={!project}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {label.role(r)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {kind === "human" && (
        <label htmlFor="hub-hub-orgadmin" className="check mb-2">
          <input id="hub-hub-orgadmin" type="checkbox" checked={orgAdmin} onChange={(e) => setOrgAdmin(e.target.checked)} /> {t("hub.orgAdmin")}
        </label>
      )}
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" disabled={!a.trim() || (kind === "human" && !name.trim())} onClick={() => void save()}>
          {t(kind === "human" ? "hub.addUser" : "hub.addAgent")}
        </button>
      </div>
    </Modal>
  );
}

function ProjectsTab() {
  const t = useT();
  const toast = useToast();
  const projects = useProjectsList();
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState<AdminProject | null>(null);
  const [pulling, setPulling] = useState<string | null>(null);
  const [moving, setMoving] = useState<AdminProject | null>(null);
  const pull = async (p: AdminProject) => {
    setPulling(p.id);
    try {
      const r = await api<{ result: PullResult }>(`/api/p/${encodeURIComponent(p.id)}/git/pull`, { method: "POST" });
      toast({ text: `${p.name}: ${r.result.message}`, error: r.result.status === "failed" });
      projects.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    } finally {
      setPulling(null);
    }
  };
  const remove = async (p: AdminProject) => {
    if (!confirm(t("hub.unregisterConfirm"))) return;
    try {
      await api(`/api/admin/projects/${p.id}`, { method: "DELETE" });
      projects.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  return (
    <>
      <div className="toolbar">
        <span className="faint">
          {projects.data?.pull_minutes ? t("hub.pullEvery").replace("{n}", String(projects.data.pull_minutes)) : t("hub.pullManual")}
        </span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" /> {t("hub.addProject")}
        </button>
      </div>
      {!projects.data ? (
        <Loading />
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t("hub.name")}</th>
                <th>{t("hub.folder")}</th>
                <th className="num">{t("hub.memberCount")}</th>
                <th>{t("hub.linked")}</th>
                <th>{t("hub.git")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((p) => (
                <tr key={p.id}>
                  <td>
                    <a className="cell-title" href={`/p/${encodeURIComponent(p.id)}/#/inbox`}>
                      {p.name}
                    </a>
                    <div className="faint mono">{p.id}</div>
                  </td>
                  <td className="mono muted">
                    {p.path} {!p.exists && <span className="chip danger">{t("hub.missing")}</span>}
                    {p.knowledge && <span className="chip">{t(p.knowledge === "hub" ? "hub.knowledgeHub" : "hub.knowledgeRepo")}</span>}
                    <button className={`btn sm ${p.exists ? "ghost" : ""}`} onClick={() => setMoving(p)}>
                      {t("hub.changeFolder")}
                    </button>
                  </td>
                  <td className="num">{p.members}</td>
                  <td>
                    <div className="row gap-2">
                      {p.linked.map((l) => (
                        <span key={l} className="chip mono">
                          {l}
                        </span>
                      ))}
                      <button className="btn sm ghost" onClick={() => setLinking(p)}>
                        {p.linked.length ? t("hub.editLinks") : t("hub.addLinks")}
                      </button>
                    </div>
                  </td>
                  <td>
                    <PullState r={p.pull} />
                  </td>
                  <td className="actions">
                    <button className="btn sm" disabled={pulling === p.id} onClick={() => void pull(p)}>
                      <Icon name="download" /> {t("hub.pullNow")}
                    </button>
                    <button className="btn sm ghost danger" onClick={() => void remove(p)}>
                      {t("hub.unregister")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddProject onClose={() => setAdding(false)} onDone={() => (setAdding(false), projects.reload())} />}
      {moving && <FolderDialog project={moving} onClose={() => setMoving(null)} onDone={() => (setMoving(null), projects.reload())} />}
      {linking && projects.data && (
        <LinksDialog project={linking} all={projects.data.projects} onClose={() => setLinking(null)} onDone={() => (setLinking(null), projects.reload())} />
      )}
    </>
  );
}

// A project's code folder on this machine: after a hub is restored elsewhere, or a checkout moved. Knowledge held
// in the hub's folder does not move; the code folder is where code links and pulls look.
function FolderDialog({ project, onClose, onDone }: { project: AdminProject; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [path, setPath] = useState(project.path);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api(`/api/admin/projects/${encodeURIComponent(project.id)}/path`, { method: "PUT", body: { path } });
      toast({ text: t("hub.folderSaved") });
      onDone();
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("hub.folderTitle").replace("{name}", project.name)}>
      <form onSubmit={(e) => void save(e)}>
        <ErrorBox error={err} />
        <p className="muted mt-0">{t(project.knowledge === "repo" ? "hub.folderIntroRepo" : "hub.folderIntro")}</p>
        <div className="field">
          <label htmlFor="hub-folder">{t("hub.folder")}</label>
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists to ask for this path */}
          <input id="hub-folder" className="input mono" autoFocus autoComplete="off" value={path} onChange={(e) => setPath(e.target.value)} />
        </div>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={busy || !path.trim() || path.trim() === project.path}>
            {t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// The last pull, and what waits for a person: knowledge the hub wrote but nobody committed yet.
function PullState({ r }: { r: PullResult | null }) {
  const t = useT();
  if (!r) return <span className="faint">{t("hub.pullNever")}</span>;
  const tone = r.status === "failed" ? "danger" : r.status === "skipped" ? "warn" : "ok";
  return (
    <div className="pull-state" title={`${r.message} · ${new Date(r.at).toLocaleString()}`}>
      <span className={`chip ${tone}`}>{t(`hub.pull.${r.status}` as Key)}</span>
      {r.behind ? <span className="chip warn">{t("hub.pullBehind").replace("{n}", String(r.behind))}</span> : null}
      {r.pending ? <span className="chip accent">{t("hub.pullPending").replace("{n}", String(r.pending))}</span> : null}
      <Ago iso={r.at} />
    </div>
  );
}

// Which projects this one reads from: a mobile app linking its backend, say. Saved to the project's
// cortex.config.yaml. Offering to add its AI agents as Readers because a link alone grants nothing.
function LinksDialog({ project, all, onClose, onDone }: { project: AdminProject; all: AdminProject[]; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>(project.linked);
  const [grant, setGrant] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const others = all.filter((p) => p.id !== project.id);
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ linked: string[]; granted: { project: string; agent: string }[] }>(`/api/admin/projects/${encodeURIComponent(project.id)}/links`, {
        method: "PUT",
        body: { linked: picked, grant_readers: grant },
      });
      toast({ text: r.granted.length ? t("hub.linksSavedGranted").replace("{n}", String(r.granted.length)) : t("hub.linksSaved") });
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal onClose={onClose} title={t("hub.linksTitle").replace("{name}", project.name)}>
      <ErrorBox error={err} />
      <p className="muted mt-0">{t("hub.linksIntro")}</p>
      {others.length ? (
        <div className="stack">
          {others.map((p) => (
            <label key={p.id} htmlFor={`hub-link-${p.id}`} className="check">
              <input id={`hub-link-${p.id}`} type="checkbox" checked={picked.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}{" "}
              <span className="faint mono">{p.id}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="faint">{t("hub.linksNone")}</p>
      )}
      <label htmlFor="hub-link-grant" className="check">
        <input id="hub-link-grant" type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} /> {t("hub.linksGrant")}
      </label>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>
          {t("common.save")}
        </button>
      </div>
    </Modal>
  );
}

function AddProject({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useT();
  const { lang } = useContext(LangContext);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [init, setInit] = useState(true);
  const [language, setLanguage] = useState<string>(lang);
  const [err, setErr] = useState<unknown>(null);
  const save = async () => {
    setErr(null);
    try {
      await api("/api/admin/projects", { method: "POST", body: { path, name: name || undefined, init, language } });
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <Modal onClose={onClose} title={t("hub.addProject")}>
      <ErrorBox error={err} />
      <div className="field">
        <label htmlFor="hub-hub-folder">{t("hub.folder")}</label>
        <input id="hub-hub-folder" className="input mono" autoFocus placeholder="/srv/repos/shop" value={path} onChange={(e) => setPath(e.target.value)} />
        <span className="hint">{t("hub.folderHint")}</span>
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="hub-hub-name-2">{t("hub.name")}</label>
          <input id="hub-hub-name-2" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="hub-hub-contentlanguage">{t("hub.contentLanguage")}</label>
          <select id="hub-hub-contentlanguage" className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="tr">Türkçe</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>
      <label htmlFor="hub-hub-createcortex" className="check">
        <input id="hub-hub-createcortex" type="checkbox" checked={init} onChange={(e) => setInit(e.target.checked)} /> {t("hub.createCortex")}
      </label>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" disabled={!path.trim()} onClick={() => void save()}>
          {t("hub.addProject")}
        </button>
      </div>
    </Modal>
  );
}

// ---- project members (inside a project board) ------------------------------------------------

type ProjectMember = { principal: string; kind: "human" | "ai"; role: string; scope: "all" | "own"; branches: string[]; name: string; email?: string };

export function MembersPage({ canManage }: { canManage: boolean }) {
  const t = useT();
  const label = useLabels();
  const toast = useToast();
  const members = useApi<{ members: ProjectMember[] }>("/api/members");
  const candidates = useApi<{ candidates: { id: string; name: string; kind: "human" | "ai" }[] }>(canManage ? "/api/members/candidates" : null);
  const [pick, setPick] = useState("");
  const [adding, setAdding] = useState<"human" | "ai" | null>(null);
  const [secret, setSecret] = useState<{ title: string; value: string; hint: string; connect?: { project?: string } } | null>(null);

  const save = async (principal: string, body: object) => {
    try {
      await api(`/api/members/${principal}`, { method: "PUT", body });
      members.reload();
      candidates.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  // A new token for one of this project's agents, with the setup guide. The server refuses when the agent also
  // works on projects the caller cannot manage (the token acts there too).
  const newToken = async (m: ProjectMember) => {
    if (!confirm(t("hub.rotateConfirm").replace("{name}", m.name))) return;
    try {
      const r = await api<{ token: string }>(`/api/agents/${encodeURIComponent(m.principal)}/token`, { method: "POST" });
      setSecret({ title: t("hub.token"), value: r.token, hint: t("hub.tokenHint"), connect: { project: currentProject() ?? undefined } });
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };
  const remove = async (m: ProjectMember) => {
    if (!confirm(t("hub.removeConfirm"))) return;
    try {
      await api(`/api/members/${m.principal}`, { method: "DELETE" });
      members.reload();
      candidates.reload();
    } catch (e) {
      toast({ text: (e as Error).message, error: true });
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("nav.members")}</h1>
          <p>{t("hub.membersIntro")}</p>
        </div>
      </div>
      {canManage && (
        <div className="toolbar">
          {candidates.data && candidates.data.candidates.length > 0 && (
            <>
              <select className="select select-wide" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t("hub.orExisting")}>
                <option value="">{t("hub.orExisting")}</option>
                {candidates.data.candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind === "human" ? t("hub.person") : t("hub.agent")})
                  </option>
                ))}
              </select>
              <button className="btn" disabled={!pick} onClick={() => void save(pick, {}).then(() => setPick(""))}>
                <Icon name="plus" /> {t("hub.addMember")}
              </button>
            </>
          )}
          <span className="spacer" />
          <button className="btn" onClick={() => setAdding("ai")}>
            <Icon name="plus" /> {t("hub.newAgent")}
          </button>
          <button className="btn primary" onClick={() => setAdding("human")}>
            <Icon name="plus" /> {t("hub.invitePerson")}
          </button>
        </div>
      )}
      {!members.data ? (
        <Loading />
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>{t("hub.name")}</th>
                <th>{t("hub.role")}</th>
                <th>{t("hub.scope")}</th>
                <th>{t("hub.branches")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.data.members.map((m) => (
                <tr key={m.principal}>
                  <td>
                    <div className="cell-title">
                      {m.name} <span className="chip type">{m.kind === "human" ? t("hub.person") : t("hub.agent")}</span>
                    </div>
                    <div className="faint">{m.email ?? m.principal}</div>
                  </td>
                  <td>
                    {canManage ? (
                      <select className="select" value={m.role} onChange={(e) => void save(m.principal, { role: e.target.value })}>
                        {(m.kind === "human" ? HUMAN_ROLES : AI_ROLES).map((r) => (
                          <option key={r} value={r}>
                            {label.role(r)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      label.role(m.role)
                    )}
                  </td>
                  <td>
                    {canManage ? (
                      <select className="select" value={m.scope} onChange={(e) => void save(m.principal, { scope: e.target.value })}>
                        <option value="all">{t("hub.scopeAll")}</option>
                        <option value="own">{t("hub.scopeOwn")}</option>
                      </select>
                    ) : m.scope === "all" ? (
                      t("hub.scopeAll")
                    ) : (
                      t("hub.scopeOwn")
                    )}
                  </td>
                  <td>
                    {canManage ? (
                      <BranchesInput value={m.branches} onSave={(branches) => void save(m.principal, { branches })} />
                    ) : (
                      m.branches.join(", ") || "—"
                    )}
                  </td>
                  <td className="actions">
                    {canManage && m.kind === "ai" && (
                      <button className="btn sm" onClick={() => void newToken(m)}>
                        {t("hub.rotate")}
                      </button>
                    )}
                    {canManage && (
                      <button className="btn sm ghost danger" onClick={() => void remove(m)}>
                        {t("hub.remove")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="faint fine-print mt-4">{t("hub.rolesHelp")}</p>
      {adding && (
        <AddToProject
          kind={adding}
          onClose={() => setAdding(null)}
          onDone={(result) => {
            setAdding(null);
            members.reload();
            candidates.reload();
            if (result) setSecret(result);
            else toast({ text: t("hub.alreadyMember") });
          }}
        />
      )}
      {secret && <Secret title={secret.title} value={secret.value} hint={secret.hint} onClose={() => setSecret(null)} connect={secret.connect} />}
    </>
  );
}

// Comma-separated branch list; saved on Enter or when the field loses focus, and only if it changed.
function BranchesInput({ value, onSave }: { value: string[]; onSave: (branches: string[]) => void }) {
  const t = useT();
  const [text, setText] = useState(value.join(", "));
  const commit = () => {
    const next = text
      .split(",")
      .map((b) => b.trim())
      .filter(Boolean);
    if (next.join(",") !== value.join(",")) onSave(next);
  };
  return (
    <input
      className="input"
      value={text}
      placeholder={t("hub.branchesHint")}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
    />
  );
}

// Invite a person, or create an AI agent, straight from a project. A project's owner or admin can do this;
// what they hand out never reaches beyond this project.
function AddToProject({
  kind,
  onClose,
  onDone,
}: {
  kind: "human" | "ai";
  onClose: () => void;
  onDone: (secret: { title: string; value: string; hint: string; connect?: { project?: string } } | null) => void;
}) {
  const t = useT();
  const label = useLabels();
  const [who, setWho] = useState(""); // email or agent id
  const [name, setName] = useState("");
  const [role, setRole] = useState(kind === "human" ? "member" : "trusted");
  const [scope, setScope] = useState("all");
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      if (kind === "human") {
        const r = await api<{ invite_url?: string }>("/api/members/invite", { method: "POST", body: { email: who, name, role, scope } });
        onDone(r.invite_url ? { title: t("hub.inviteLink"), value: r.invite_url, hint: t("hub.inviteLinkHint") } : null);
      } else {
        const r = await api<{ token: string }>("/api/agents", { method: "POST", body: { id: who, name, role } });
        onDone({ title: t("hub.token"), value: r.token, hint: t("hub.tokenHint"), connect: { project: currentProject() ?? undefined } });
      }
    } catch (e) {
      setErr(e);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} title={t(kind === "human" ? "hub.invitePerson" : "hub.newAgent")}>
      <p className="muted mt-0">{t(kind === "human" ? "hub.inviteHint" : "hub.agentHint")}</p>
      <ErrorBox error={err} />
      <div className="field">
        <label htmlFor="hub-who-2">{t(kind === "human" ? "hub.email" : "hub.agentId")}</label>
        <input
          id="hub-who-2"
          className={`input ${kind === "ai" ? "mono" : ""}`}
          autoFocus
          type={kind === "human" ? "email" : "text"}
          value={who}
          onChange={(e) => setWho(e.target.value)}
        />
        {kind === "ai" && <span className="hint">{t("hub.agentIdHint")}</span>}
      </div>
      <div className="field">
        <label htmlFor="hub-hub-name-3">{t("hub.name")}</label>
        <input id="hub-hub-name-3" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="grid2">
        <div className="field">
          <label htmlFor="hub-hub-role-2">{t("hub.role")}</label>
          <select id="hub-hub-role-2" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {(kind === "human" ? HUMAN_ROLES : AI_ROLES).map((r) => (
              <option key={r} value={r}>
                {label.role(r)}
              </option>
            ))}
          </select>
        </div>
        {kind === "human" && (
          <div className="field">
            <label htmlFor="hub-hub-scope">{t("hub.scope")}</label>
            <select id="hub-hub-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">{t("hub.scopeAll")}</option>
              <option value="own">{t("hub.scopeOwn")}</option>
            </select>
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          {t("common.cancel")}
        </button>
        <button className="btn primary" disabled={busy || !who.trim() || (kind === "human" && !name.trim())} onClick={() => void save()}>
          {t(kind === "human" ? "hub.invitePerson" : "hub.newAgent")}
        </button>
      </div>
    </Modal>
  );
}

// ---- usage ------------------------------------------------------------------------------------

type Usage = {
  by_principal: { principal: string; name: string; kind: string; project_id: string; calls: number; bytes: number; tokens: number; last_at: string }[];
  by_route: { principal: string; route: string; calls: number; bytes: number; tokens: number }[];
  daily: { date: string; ai: number; human: number; ai_tokens: number; human_tokens: number }[];
  totals: { calls: number; bytes: number; tokens: number };
  projects?: { id: string; name: string }[];
};

const PERIODS = ["7d", "30d", "90d"];
const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const num = (n: number) => n.toLocaleString();

// Tucked behind Organization on purpose: nobody needs this to do their work, only to explain a bill.
function UsageTab() {
  const t = useT();
  const { lang } = useContext(LangContext);
  const [since, setSince] = useState("7d");
  const [project, setProject] = useState("");
  const [kind, setKind] = useState("");
  const [show, setShow] = useState<"calls" | "tokens">("tokens");
  const { data, loading } = useApi<Usage>(`/api/admin/usage${qs({ since, project, kind })}`);

  const dayLabel = (row: Record<string, number | string>) =>
    new Date(`${row.date}T00:00:00Z`).toLocaleDateString(lang, { day: "numeric", month: "short", timeZone: "UTC" });
  const totals = data?.totals ?? { calls: 0, bytes: 0, tokens: 0 };
  const aiTokens = (data?.by_principal ?? []).filter((r) => r.kind === "ai").reduce((n, r) => n + r.tokens, 0);
  const humanTokens = (data?.by_principal ?? []).filter((r) => r.kind === "human").reduce((n, r) => n + r.tokens, 0);
  const busiest = (data?.by_principal ?? [])[0];

  return (
    <>
      <p className="muted measure mt-0">{t("usage.intro")}</p>
      <div className="toolbar">
        <div className="segmented" role="group">
          {PERIODS.map((p) => (
            <button key={p} className={since === p ? "on" : ""} aria-pressed={since === p} onClick={() => setSince(p)}>
              {parseInt(p, 10)} {t("rep.days")}
            </button>
          ))}
        </div>
        <div className="segmented" role="group">
          {[
            ["", "usage.everyone"],
            ["human", "usage.people"],
            ["ai", "usage.agents"],
          ].map(([value, key]) => (
            <button key={value} className={kind === value ? "on" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>
              {t(key as "usage.people")}
            </button>
          ))}
        </div>
        <select className="select select-wide" value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">{t("usage.allProjects")}</option>
          {(data?.projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {loading && !data ? (
        <Loading />
      ) : totals.calls === 0 ? (
        <EmptyState icon="report" title={t("usage.empty")} />
      ) : (
        <>
          <div className="kpis">
            <Tile icon="chat" label={t("usage.calls")} value={num(totals.calls)} />
            <Tile icon="zap" label={t("usage.tokens")} value={num(totals.tokens)} sub={kb(totals.bytes)} />
            <Tile icon="target" label={t("usage.avg")} value={num(Math.round(totals.tokens / Math.max(1, totals.calls)))} sub={t("usage.tokens")} />
            <Tile
              icon="percent"
              tone="ai"
              label={t("usage.share")}
              value={`${Math.round((aiTokens / Math.max(1, totals.tokens)) * 100)}%`}
              sub={`${num(aiTokens)} ${t("usage.tokens")}`}
            />
            <Tile
              icon="user"
              tone="human"
              label={t("usage.humanShare")}
              value={`${Math.round((humanTokens / Math.max(1, totals.tokens)) * 100)}%`}
              sub={`${num(humanTokens)} ${t("usage.tokens")}`}
            />
            <Tile
              icon="star"
              tone={busiest ? (busiest.kind === "ai" ? "ai" : "human") : undefined}
              label={t("usage.busiest")}
              value={busiest?.name ?? t("usage.noneYet")}
              sub={busiest ? `${num(busiest.tokens)} ${t("usage.tokens")}` : undefined}
              small
            />
          </div>

          <div className="charts">
            <section className="card chart-card">
              <div className="chart-head">
                <h2>{t("usage.byDay")}</h2>
                <div className="legend" aria-hidden>
                  <span>
                    <i className="key-ai" />
                    {t("usage.agents")}
                  </span>
                  <span>
                    <i className="key-human" />
                    {t("usage.people")}
                  </span>
                </div>
                <span className="spacer" />
                <div className="segmented" role="group">
                  {(["tokens", "calls"] as const).map((k) => (
                    <button key={k} className={show === k ? "on" : ""} aria-pressed={show === k} onClick={() => setShow(k)}>
                      {t(k === "tokens" ? "usage.showTokens" : "usage.showCalls")}
                    </button>
                  ))}
                </div>
              </div>
              <StackedColumns
                data={(data?.daily ?? []).map((d) => ({
                  date: d.date,
                  ai: show === "tokens" ? d.ai_tokens : d.ai,
                  human: show === "tokens" ? d.human_tokens : d.human,
                }))}
                series={[
                  { key: "ai", label: t("usage.agents"), color: "var(--viz-ai)" },
                  { key: "human", label: t("usage.people"), color: "var(--viz-human)" },
                ]}
                xLabel={dayLabel}
                ariaLabel={t("usage.byDay")}
              />
            </section>
            <section className="card chart-card">
              <div className="chart-head">
                <h2>{t("usage.topRoutes")}</h2>
              </div>
              <HBars
                data={(data?.by_route ?? []).slice(0, 8).map((r) => ({ label: r.route.replace(/^(MCP )?(GET|POST|PUT|PATCH|DELETE) /, ""), value: r.tokens }))}
                color="var(--viz-bar)"
                ariaLabel={t("usage.topRoutes")}
                detail={(i) => {
                  const r = (data?.by_route ?? [])[i];
                  return (
                    <>
                      <div className="faint mb-1">{r.route}</div>
                      <div className="tip-row">
                        <b>{num(r.tokens)}</b> <span className="muted">{t("usage.tokens")}</span>
                      </div>
                      <div className="tip-row">
                        <b>{r.calls}</b> <span className="muted">{t("usage.calls")}</span>
                      </div>
                      <div className="faint">{r.principal}</div>
                    </>
                  );
                }}
              />
            </section>
          </div>

          <div className="card mb-4">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("usage.who")}</th>
                  <th>{t("hub.projects")}</th>
                  <th className="num">{t("usage.calls")}</th>
                  <th className="num">{t("usage.tokens")}</th>
                  <th className="num">{t("usage.perCall")}</th>
                  <th className="num">{t("usage.data")}</th>
                  <th>{t("usage.last")}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_principal ?? []).map((r) => (
                  <tr key={`${r.principal}-${r.project_id}`}>
                    <td>
                      <div className="cell-title">
                        {r.name} <span className={`chip ${r.kind === "ai" ? "ai" : "human"}`}>{r.kind === "ai" ? t("hub.agent") : t("hub.person")}</span>
                      </div>
                      <div className="faint mono">{r.principal}</div>
                    </td>
                    <td className="muted mono">{r.project_id}</td>
                    <td className="num">{r.calls}</td>
                    <td className="num">{num(r.tokens)}</td>
                    <td className="num">{num(Math.round(r.tokens / r.calls))}</td>
                    <td className="num">{kb(r.bytes)}</td>
                    <td className="muted">
                      <Ago iso={r.last_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint fine-print">{t("usage.estimate")}</p>
        </>
      )}
    </>
  );
}

function Tile({ label, value, sub, small, icon, tone }: { label: string; value: string; sub?: string; small?: boolean; icon?: string; tone?: "ai" | "human" }) {
  return (
    <div className="card kpi">
      <div className="kpi-head">
        {icon && (
          <span className={`kpi-icon${tone ? ` ${tone}` : ""}`}>
            <Icon name={icon} size={13} />
          </span>
        )}
        <div className="label">{label}</div>
      </div>
      <div className={`value${tone ? ` ${tone}` : ""}`} style={small ? { fontSize: "var(--text-md)", fontWeight: 600 } : undefined}>
        {value}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
