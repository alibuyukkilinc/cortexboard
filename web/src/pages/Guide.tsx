import type { ReactNode } from "react";
import { useContext } from "react";
import { currentProject, useApi } from "../api";
import { GLOSSARY, LangContext, useLabels, useT } from "../i18n";
import { Icon, Term, useSession, useToast } from "../ui";

// The manual: what this thing is, how a day with it looks, how an AI connects, who may do what.
// Written for someone who has never seen Cortex before.

export function Guide() {
  const t = useT();
  const { lang } = useContext(LangContext);
  const tr = lang === "tr";
  const label = useLabels();
  const { projectName } = useSession();
  const health = useApi<{ mode: "hub" | "project" }>("/api/health", { on: [] });
  const project = currentProject();
  const hub = health.data?.mode === "hub";
  const origin = location.origin;

  const mcpCommand = hub
    ? `claude mcp add cortex -- npx cortexboard mcp --hub ${origin} --project ${project} --token <TOKEN>`
    : "claude mcp add cortex -- npx cortexboard mcp --actor ai-agent";

  return (
    <div className="guide">
      <div className="page-head">
        <div>
          <h1>{t("guide.title")}</h1>
          <p>{t("guide.intro").replace("{project}", projectName)}</p>
        </div>
      </div>

      <Section title={t("guide.whatTitle")}>
        <p>{t("guide.whatBody")}</p>
        <ul>
          <li>
            <b>{t("guide.whatTree")}</b> {t("guide.whatTreeBody")}
          </li>
          <li>
            <b>{t("guide.whatItems")}</b> {t("guide.whatItemsBody")}
          </li>
          <li>
            <b>{t("guide.whatActivity")}</b> {t("guide.whatActivityBody")}
          </li>
          <li>
            <b>{t("guide.whatApprovals")}</b> {t("guide.whatApprovalsBody")} <Term w="draft">{tr ? "taslak" : "draft"}</Term>.
          </li>
          <li>
            <b>{t("guide.whatStale")}</b> {t("guide.whatStaleBody")} <Term w="commit" /> · <Term w="stale" />.
          </li>
        </ul>
      </Section>

      <Section title={t("guide.dayTitle")}>
        <ol>
          <li>{t("guide.day1")}</li>
          <li>{t("guide.day2")}</li>
          <li>{t("guide.day3")}</li>
          <li>{t("guide.day4")}</li>
          <li>{t("guide.day5")}</li>
        </ol>
      </Section>

      <Section title={t("guide.aiTitle")}>
        <p>
          {t("guide.aiBody")} <Term w="MCP" />
        </p>
        <Copy text={mcpCommand} />
        {hub ? <p className="muted">{t("guide.aiHub")}</p> : <p className="muted">{t("guide.aiLocal")}</p>}
        <p>{t("guide.aiProtocol")}</p>
        <ul>
          <li>{t("guide.aiStep1")}</li>
          <li>{t("guide.aiStep2")}</li>
          <li>{t("guide.aiStep3")}</li>
          <li>{t("guide.aiStep4")}</li>
        </ul>
        {hub && (
          <>
            <p className="muted">{t("guide.aiRemote")}</p>
            <Copy text={`${origin}/mcp/p/${project}`} />
          </>
        )}
        <p className="muted">{t("guide.aiRest")}</p>
        <Copy text={`curl -H "Authorization: Bearer <TOKEN>" ${origin}${hub ? `/api/p/${project}` : "/api"}/brief`} />
      </Section>

      <Section title={t("guide.rolesTitle")}>
        <p>{t("guide.rolesBody")}</p>
        <table className="table">
          <thead>
            <tr>
              <th>{t("hub.role")}</th>
              <th>{t("guide.rolesFor")}</th>
              <th>{t("guide.rolesCan")}</th>
            </tr>
          </thead>
          <tbody>
            {[
              ["owner", "human", "guide.roleOwner"],
              ["admin", "human", "guide.roleAdmin"],
              ["member", "human", "guide.roleMember"],
              ["viewer", "human", "guide.roleViewer"],
              ["reader", "ai", "guide.roleReader"],
              ["contributor", "ai", "guide.roleContributor"],
              ["trusted", "ai", "guide.roleTrusted"],
            ].map(([role, kind, key]) => (
              <tr key={role}>
                <td>
                  <b>{label.role(role)}</b>
                </td>
                <td className="muted">{kind === "human" ? t("hub.person") : t("hub.agent")}</td>
                <td className="muted">{t(key as "guide.roleOwner")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          <b>{t("guide.scopeTitle")}</b> {t("guide.scopeBody")} <Term w="scope" />
        </p>
      </Section>

      <Section title={t("guide.teamTitle")}>
        <p>{t("guide.teamBody")}</p>
        <div className="guide-cards">
          <div className="card guide-card">
            <h3>{t("guide.teamAOption")}</h3>
            <p>{t("guide.teamA")}</p>
          </div>
          <div className="card guide-card">
            <h3>{t("guide.teamBOption")}</h3>
            <p>{t("guide.teamB")}</p>
          </div>
        </div>
        <p className="muted">{t("guide.teamNote")}</p>
      </Section>

      <Section title={t("guide.termsTitle")}>
        <p className="muted">{t("guide.termsBody")}</p>
        <dl className="kv glossary">
          {["MCP", "commit", "git", "repo", "draft", "stale", "token", "branch", "node", "issue", "hub", "API", "REST", "scope", "agent"].map((w) => (
            <GlossaryRow key={w} word={w} />
          ))}
        </dl>
      </Section>
    </div>
  );
}

// Read straight from the shared glossary so the page and the tooltips never drift apart.
const GLOSSARY_TEXT = (w: string, lang: "en" | "tr") => GLOSSARY[w]?.[lang] ?? "";

function GlossaryRow({ word }: { word: string }) {
  const { lang } = useContext(LangContext);
  return (
    <>
      <dt className="mono">{word}</dt>
      <dd>{GLOSSARY_TEXT(word, lang)}</dd>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="guide-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function Copy({ text }: { text: string }) {
  const t = useT();
  const toast = useToast();
  return (
    <div className="secret">
      <code>{text}</code>
      <button className="btn sm" onClick={() => void navigator.clipboard.writeText(text).then(() => toast({ text: t("hub.copied") }))}>
        <Icon name="file" size={13} /> {t("hub.copy")}
      </button>
    </div>
  );
}
