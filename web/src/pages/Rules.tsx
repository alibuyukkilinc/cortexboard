import { useEffect, useState } from "react";
import { api, useApi } from "../api";
import { useT } from "../i18n";
import { ErrorBox, Icon, Loading, go, useSession, useToast } from "../ui";

const SPECIAL = ["_global", "activity", "node"];

const NEW_TYPE = (name: string) => `# Edited by humans only. Cortex enforces these rules and explains violations to AIs.
type: ${name}
description: ""
statuses: [open, done]
initial: open
terminal: [done]
transitions: any
human_only_statuses: []
fields: {}
ai_instructions: ""
`;

export function Rules({ name }: { name: string }) {
  const t = useT();
  const { allItemTypes, me } = useSession();
  const names = [...SPECIAL, ...allItemTypes];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{t("rules.title")}</h1>
          <p>{t("rules.intro")}</p>
        </div>
      </div>
      <div className="split">
        <nav className="card tree">
          {names.map((n) => (
            <div key={n} className={`tree-row ${n === name ? "active" : ""}`}>
              <a className="name mono" href={`#/rules/${n}`} aria-current={n === name ? "page" : undefined}>
                {n}
              </a>
            </div>
          ))}
          {me.kind === "human" && (
            <button
              type="button"
              className="tree-row"
              onClick={() => {
                const n = prompt(t("rules.newTypeName"))?.trim().toLowerCase();
                if (n) go(`rules/${n}?new=1`);
              }}
            >
              <Icon name="plus" size={14} /> <span className="name">{t("rules.newType")}</span>
            </button>
          )}
        </nav>
        <RuleEditor key={name} name={name} />
      </div>
    </>
  );
}

function RuleEditor({ name }: { name: string }) {
  const t = useT();
  const toast = useToast();
  const { can } = useSession();
  const { data, error, loading } = useApi<{ source: string; exists: boolean; file: string }>(`/api/rules/${name}/source`, { on: [] });
  const [source, setSource] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);

  useEffect(() => {
    // Keep local edits when a live refresh arrives; only seed from the server once.
    if (data && source === null) setSource(data.source || NEW_TYPE(name));
  }, [data, source, name]);

  const save = async () => {
    setErr(null);
    try {
      await api(`/api/rules/${name}/source`, { method: "PUT", body: { source } });
      toast({ text: t("rules.saved") });
    } catch (e) {
      setErr(e);
    }
  };

  if (error && !data)
    return (
      <div className="card doc">
        <ErrorBox error={error} />
      </div>
    );
  if (loading || source === null)
    return (
      <div className="card">
        <Loading />
      </div>
    );
  const dirty = source !== data?.source;
  return (
    <div className="card doc">
      <div className="row mb-3">
        <h2 className="mono grow">.cortex/rules/{data?.file}</h2>
        <button className="btn primary" disabled={!dirty || !can("edit_rules")} onClick={() => void save()}>
          {t("common.save")}
        </button>
      </div>
      <textarea className="textarea code" spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} aria-label={name} />
      <div className="mt-3">
        <ErrorBox error={err} />
      </div>
    </div>
  );
}
