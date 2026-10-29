import { BoardPrompts } from "./BoardPrompts";
import { CountsProvider, useCounts } from "./counts";
import { Dictation } from "./dictation";
import type { FormEvent } from "react";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ApiError } from "./api";
import type { Live } from "./api";
import { LiveContext, api, apiPath, currentProject, useApi } from "./api";
import { AdminPage, ForgotPage, HubFrame, HubHome, HubLogin, InvitePage, MembersPage, ProjectSwitcher, UserMenu, useHubMe } from "./hub";
import type { Key, Lang } from "./i18n";
import { LangContext, initialLang, timeAgo, useT } from "./i18n";
import { AskDialog, ItemDrawer } from "./items";
import { ProjectBackupsPage } from "./backups";
import { Activity } from "./pages/Activity";
import { Approvals } from "./pages/Approvals";
import { Archive } from "./pages/Archive";
import { Board } from "./pages/Board";
import { DiscussionView, Discussions } from "./pages/Discussions";
import { Inbox } from "./pages/Inbox";
import { Guide } from "./pages/Guide";
import { Knowledge } from "./pages/Knowledge";
import { Reports } from "./pages/Reports";
import { Stale } from "./pages/Stale";
import { Rules } from "./pages/Rules";
import { Search } from "./pages/Search";
import type { Activity as Entry, HubMe, Me } from "./types";
import { Icon, Loading, PageGate, SessionContext, ToastProvider, go, routeQuery, useRoute } from "./ui";

export function App() {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("cortex.lang", l);
    } catch {
      // storage blocked: the choice lasts for this tab only
    }
  };
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  return (
    <LangContext.Provider value={{ lang, setLang }}>
      <ToastProvider>
        <Root />
        <Dictation />
      </ToastProvider>
    </LangContext.Provider>
  );
}

// Which screen: the server says whether it is a single project or a hub; the path says where we are.
//   hub:  /invite/<token> · /forgot · /admin (organization) · /p/<project>/ (a board) · / (projects)
//   single project: the board at /
function Root() {
  const [health, setHealth] = useState<{ mode: "hub" | "project"; org?: string; mail?: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ mode: "project" }));
  }, []);
  if (!health) return <Loading />;
  const path = location.pathname;
  if (health.mode === "hub") {
    const invite = /^\/invite\/([^/]+)/.exec(path);
    if (invite) return <InvitePage token={decodeURIComponent(invite[1])} />;
    if (path === "/forgot") return <ForgotPage org={health.org} />;
    return <HubRoot org={health.org} mail={health.mail} />;
  }
  return <ProjectRoot />;
}

function ProjectRoot({ hubMe }: { hubMe?: HubMe }) {
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<"loading" | "ok" | "login" | "forbidden">("loading");
  useEffect(() => {
    api<Me>("/api/me")
      .then((m) => {
        setMe(m);
        setStatus("ok");
      })
      .catch((e: ApiError) => setStatus(e.status === 403 || e.status === 404 ? "forbidden" : "login"));
  }, []);
  if (status === "loading") return <Loading />;
  if (status === "forbidden" && hubMe) return <NotMember me={hubMe} />;
  if (status !== "ok" || !me) return <LoginScreen />;
  return <Shell me={me} hubMe={hubMe} />;
}

function HubRoot({ org, mail }: { org?: string; mail?: boolean }) {
  const me = useHubMe();
  if (me.loading && !me.data) return <Loading />;
  if (!me.data) return <HubLogin org={org} mail={mail} />;
  if (currentProject()) return <ProjectRoot hubMe={me.data} />;
  if (location.pathname.startsWith("/admin") && me.data.principal.org_admin) return <AdminPage me={me.data} />;
  return <HubHome me={me.data} />;
}

function NotMember({ me }: { me: HubMe }) {
  const t = useT();
  return (
    <HubFrame me={me}>
      <div className="card empty">
        <p>{t("hub.notMember")}</p>
        <a className="btn" href="/">
          {t("hub.backHome")}
        </a>
      </div>
    </HubFrame>
  );
}

function LoginScreen() {
  const t = useT();
  return (
    <div className="login-page">
      <div className="card login-card">
        <div className="brand mb-4">
          <span className="brand-mark">
            <Icon name="activity" size={14} />
          </span>
          Cortex
        </div>
        <h1 className="mb-2">{t("login.title")}</h1>
        <p className="muted">{t("login.body")}</p>
        <pre className="card login-cmd">npx cortexboard login</pre>
        <p className="muted">{t("login.after")}</p>
      </div>
    </div>
  );
}

// Server-sent events: every write anywhere (API, MCP process, git pull) bumps `live`, which refreshes open views.
function useLive() {
  const [live, setLive] = useState<Live>({ version: 0, kinds: new Set() });
  const kinds = useRef(new Set<string>());
  const [connected, setConnected] = useState(false);
  const [last, setLast] = useState<Entry | null>(null);
  const [pulse, setPulse] = useState(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const es = new EventSource(apiPath("/api/events"));
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as { type: string; kind?: string; entry?: Entry };
        if (e.entry && !e.entry.system) setLast(e.entry);
        kinds.current.add(e.kind ?? "reindex"); // an older server names nothing: refresh everything
      } catch {
        kinds.current.add("reindex");
      }
      setPulse((p) => p + 1);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        const seen = kinds.current;
        kinds.current = new Set();
        setLive((l) => ({ version: l.version + 1, kinds: seen }));
      }, 250);
    };
    return () => es.close();
  }, []);
  return { live, connected, last, pulse };
}

// Grouped by what a person comes for: today's work, the project's memory, and running the project.
type NavGroup = "work" | "memory" | "project";
const NAV: { key: Key; route: string; icon: string; group: NavGroup }[] = [
  { key: "nav.inbox", route: "inbox", icon: "inbox", group: "work" },
  { key: "nav.board", route: "board", icon: "board", group: "work" },
  { key: "nav.discussions", route: "discussions", icon: "debate", group: "work" },
  { key: "nav.approvals", route: "approvals", icon: "check", group: "work" },
  { key: "nav.knowledge", route: "knowledge", icon: "tree", group: "memory" },
  { key: "nav.stale", route: "stale", icon: "alert", group: "memory" },
  { key: "nav.activity", route: "activity", icon: "activity", group: "memory" },
  { key: "nav.archive", route: "archive", icon: "archive", group: "memory" },
  { key: "nav.reports", route: "reports", icon: "report", group: "project" },
  { key: "nav.rules", route: "rules", icon: "rules", group: "project" },
  { key: "nav.guide", route: "guide", icon: "ask", group: "project" },
];
const NAV_GROUPS: { id: NavGroup; key: Key }[] = [
  { id: "work", key: "nav.groupWork" },
  { id: "memory", key: "nav.groupMemory" },
  { id: "project", key: "nav.groupProject" },
];

// Collapsed to an icon rail, or pinned open. Remembered per browser; hovering the rail opens it temporarily.
function useRail(): [boolean, (v: boolean) => void] {
  const [rail, set] = useState(() => {
    try {
      return localStorage.getItem("cortex.rail") === "1";
    } catch {
      return false; // storage blocked: start with the menu open
    }
  });
  return [
    rail,
    (v: boolean) => {
      set(v);
      try {
        localStorage.setItem("cortex.rail", v ? "1" : "0");
      } catch {
        // storage blocked: the choice lasts for this tab only
      }
    },
  ];
}

function Shell({ me, hubMe }: { me: Me; hubMe?: HubMe }) {
  const [rail, setRail] = useRail();
  const live = useLive();
  const route = useRoute();
  const [openId, setOpenId] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ about: string; label: string } | null>(null);

  const session = useMemo(
    () => ({
      me: me.actor,
      actors: me.actors,
      itemTypes: me.item_types.filter((x) => x !== "discussion"),
      allItemTypes: me.item_types,
      projectName: me.project.name,
      openItem: (id: string) => setOpenId(id),
      ask: (about: string, label: string) => setAsking({ about, label }),
      // Hub members carry their role's permissions; a single project allows everything a human can do.
      can: (perm: string) => !me.perms || me.perms.includes(perm),
      repoUrl: me.repo_url,
    }),
    [me],
  );

  // #/item/<id> opens the drawer over the page it was opened from, and closing it goes back there. Only a
  // link from outside (nothing open before it) lands on the inbox. It used to be the inbox every time: a card
  // created on the board, or a card linked from another card, sent people to Notifications.
  const under = useRef({ parts: ["inbox"], hash: "#/inbox" });
  if (route[0] !== "item") under.current = { parts: route.length ? route : ["inbox"], hash: location.hash || "#/inbox" };
  const view = route[0] === "item" ? under.current.parts : route;
  const viewQuery = route[0] === "item" ? new URLSearchParams(under.current.hash.split("?")[1] ?? "") : routeQuery();
  const page = view[0] ?? "inbox";
  useEffect(() => {
    if (route[0] === "item" && route[1]) setOpenId(route[1]);
  }, [route]);
  const closeItem = () => {
    setOpenId(null);
    if (route[0] === "item") location.hash = under.current.hash;
  };

  let content;
  switch (page) {
    case "board":
      content = <Board key={view[1]} type={view[1] ?? me.item_types[0] ?? "task"} />;
      break;
    case "discussions":
      content = view[1] ? <DiscussionView key={view[1]} id={view[1]} /> : <Discussions />;
      break;
    case "knowledge":
      content = <Knowledge path={view.slice(1).join("/")} />;
      break;
    case "activity":
      content = <Activity />;
      break;
    case "approvals":
      content = <Approvals />;
      break;
    case "rules":
      content = <Rules name={view[1] ?? "_global"} />;
      break;
    case "stale":
      content = <Stale />;
      break;
    case "archive":
      content = <Archive />;
      break;
    case "reports":
      content = <Reports />;
      break;
    case "guide":
      content = <Guide />;
      break;
    case "members":
      content = hubMe ? <MembersPage canManage={session.can("manage_members")} /> : <Inbox />;
      break;
    case "backups":
      content = hubMe ? <Inbox /> : <ProjectBackupsPage />;
      break;
    case "search":
      content = <Search q={viewQuery.get("q") ?? ""} />;
      break;
    default:
      content = <Inbox />;
  }

  return (
    <SessionContext.Provider value={session}>
      <LiveContext.Provider value={live.live}>
        <CountsProvider>
          <BoardPrompts>
            <div className={`app${rail ? " rail" : ""}`}>
              <TopBar me={me} live={live} hubMe={hubMe} rail={rail} onToggleRail={() => setRail(!rail)} />
              <SideBar page={page} hubMe={hubMe} me={me} />
              <main className="main">
                <PageGate key={`${page}/${view[1] ?? ""}`}>{content}</PageGate>
              </main>
            </div>
            {openId && <ItemDrawer key={openId} id={openId} onClose={closeItem} />}
            {asking && <AskDialog about={asking.about} label={asking.label} onClose={() => setAsking(null)} />}
          </BoardPrompts>
        </CountsProvider>
      </LiveContext.Provider>
    </SessionContext.Provider>
  );
}

function TopBar({ me, live, hubMe, rail, onToggleRail }: { me: Me; live: ReturnType<typeof useLive>; hubMe?: HubMe; rail: boolean; onToggleRail: () => void }) {
  const t = useT();
  const [q, setQ] = useState(routeQuery().get("q") ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return;
    // A new query on the search page keeps its filters.
    const next = location.hash.startsWith("#/search") ? routeQuery() : new URLSearchParams();
    next.set("q", q.trim());
    go(`search?${next.toString()}`);
  };
  const liveText = live.last ? `${live.last.actor}: ${live.last.summary} · ${timeAgo(live.last.at, t)}` : live.connected ? t("live.on") : t("live.off");

  return (
    <header className="topbar">
      <button
        className="icon-btn rail-toggle"
        onClick={onToggleRail}
        aria-pressed={rail}
        aria-controls="sidebar"
        title={t(rail ? "nav.expand" : "nav.collapse")}
        aria-label={t(rail ? "nav.expand" : "nav.collapse")}
      >
        <Icon name="sidebar" />
      </button>
      <a className="brand plain-link" href="#/inbox">
        <span className="brand-mark">
          <Icon name="activity" size={14} />
        </span>
        Cortex {!hubMe && <small>· {me.project.name}</small>}
      </a>
      {hubMe && <ProjectSwitcher me={hubMe} />}
      <form className="search" onSubmit={submit} role="search">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("search.placeholder")} aria-label={t("search.placeholder")} />
      </form>
      <div className="topbar-right">
        <span className="live" title={liveText}>
          <span key={live.pulse} className={`live-dot ${live.connected ? "on" : ""} ${live.pulse ? "pulse" : ""}`} />
          <span className="live-text">{liveText}</span>
        </span>
        <ThemeToggle />
        {hubMe && <UserMenu me={hubMe} />}
      </div>
    </header>
  );
}

function ThemeToggle() {
  const t = useT();
  const isDark = () => {
    const root = document.documentElement;
    return root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const [dark, setDark] = useState(isDark);
  const toggle = () => {
    const root = document.documentElement;
    root.dataset.theme = isDark() ? "light" : "dark";
    setDark(root.dataset.theme === "dark");
    try {
      localStorage.setItem("cortex.theme", root.dataset.theme);
    } catch {
      // storage blocked: theme lasts for this tab only
    }
  };
  return (
    <button className="icon-btn" onClick={toggle} title={t("theme.toggle")} aria-label={t("theme.toggle")}>
      <Icon name={dark ? "sun" : "moon"} />
    </button>
  );
}

function SideBar({ page, hubMe, me }: { page: string; hubMe?: HubMe; me: Me }) {
  const t = useT();
  // One small request for the badges (CountsProvider): the lists behind them are fetched by their own pages.
  // `stale` counts high and medium only: formatting-only and snoozed ones are not work.
  const badges = useCounts();
  const counts: Record<string, number> = {
    inbox: badges?.inbox ?? 0,
    discussions: badges?.discussions ?? 0,
    approvals: badges?.approvals ?? 0,
    stale: badges?.stale ?? 0,
  };
  const { lang, setLang } = useContext(LangContext);
  const logout = async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    location.reload();
  };

  // In rail mode the menu opens on hover. After a click it should get out of the way even though the
  // pointer is still over it, so hover-opening is suppressed until the pointer leaves.
  // Attached as listeners, not JSX handlers: they only watch the links' own clicks, the <nav> itself is not
  // something to click, and saying so in JSX would tell assistive tech (and the a11y lint) otherwise.
  const [held, setHeld] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const closeAfterClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest("a, button");
      if (!link) return;
      setHeld(true);
      (link as HTMLElement).blur(); // otherwise :focus-within would hold it open
    };
    const release = () => setHeld(false);
    nav.addEventListener("click", closeAfterClick, true);
    nav.addEventListener("mouseleave", release);
    return () => {
      nav.removeEventListener("click", closeAfterClick, true);
      nav.removeEventListener("mouseleave", release);
    };
  }, []);

  return (
    <nav ref={navRef} id="sidebar" className={`sidebar${held ? " held" : ""}`} aria-label="main">
      {NAV_GROUPS.map((g) => {
        const links = NAV.filter((n) => n.route !== "reports" || !me.restricted)
          .concat(
            hubMe
              ? [{ key: "nav.members", route: "members", icon: "user", group: "project" as const }]
              : me.restricted
                ? []
                : [{ key: "nav.backups", route: "backups", icon: "archive", group: "project" as const }],
          )
          .filter((n) => n.group === g.id);
        return (
          <div className="nav-group" key={g.id} role="group" aria-label={t(g.key)}>
            <span className="nav-group-label" aria-hidden>
              {t(g.key)}
            </span>
            {links.map((n) => (
              <a key={n.route} href={`#/${n.route}`} className={`nav-link ${page === n.route ? "active" : ""}`} title={t(n.key)}>
                <Icon name={n.icon} />
                <span className="nav-label">{t(n.key)}</span>
                {counts[n.route] ? (
                  <span className={`nav-count ${n.route === "stale" ? "warn" : ""}`} aria-label={`${counts[n.route]}`}>
                    {counts[n.route]}
                  </span>
                ) : null}
              </a>
            ))}
          </div>
        );
      })}
      {!hubMe && (
        <div className="sidebar-foot">
          <button className="btn ghost sm" onClick={() => setLang(lang === "tr" ? "en" : "tr")} title={t("lang.toggle")}>
            <Icon name="globe" size={14} /> <span className="nav-label">{t("lang.toggle")}</span>
          </button>
          <button className="btn ghost sm" onClick={() => void logout()} title={t("logout")}>
            <Icon name="logout" size={14} /> <span className="nav-label">{t("logout")}</span>
          </button>
        </div>
      )}
    </nav>
  );
}
