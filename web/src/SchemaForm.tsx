import type { ReactElement } from "react";
import { cloneElement } from "react";
import { useLabels, useT } from "./i18n";
import type { Actor, FieldSpec } from "./types";

// Renders inputs straight from a type's schema, so custom types defined in rules/*.schema.yaml work on the board with no UI code.

function toLocalInput(iso: unknown): string {
  if (typeof iso !== "string" || !iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SchemaForm({
  fields,
  value,
  onChange,
  actors,
  errors = {},
}: {
  fields: Record<string, FieldSpec>;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  actors: Actor[];
  errors?: Record<string, string>; // field name -> the server's message, shown beside the field
}) {
  const t = useT();
  const labels = useLabels();
  const label = labels.field;
  const set = (k: string, v: unknown) => {
    const next = { ...value };
    if (v === "" || v === undefined || (Array.isArray(v) && v.length === 0)) delete next[k];
    else next[k] = v;
    onChange(next);
  };

  return (
    <>
      {Object.entries(fields).map(([name, spec]) => {
        const v = value[name];
        const id = `f-${name}`;
        let input;
        switch (spec.type) {
          case "text":
            input = <textarea id={id} className="textarea" value={(v as string) ?? ""} onChange={(e) => set(name, e.target.value)} />;
            break;
          case "enum":
            input = (
              <select id={id} className="select" value={(v as string) ?? ""} onChange={(e) => set(name, e.target.value)}>
                <option value="">—</option>
                {spec.values?.map((o) => (
                  <option key={o} value={o}>
                    {labels.value(o)}
                  </option>
                ))}
              </select>
            );
            break;
          case "boolean":
            input = (
              <label htmlFor={id} className="check">
                <input id={id} type="checkbox" checked={v === true} onChange={(e) => set(name, e.target.checked ? true : undefined)} />
                {spec.description ? labels.hint(spec.description) : label(name)}
              </label>
            );
            break;
          case "number":
            input = (
              <input
                id={id}
                type="number"
                className="input"
                value={(v as number) ?? ""}
                onChange={(e) => set(name, e.target.value === "" ? "" : Number(e.target.value))}
              />
            );
            break;
          case "date":
            input = <input id={id} type="date" className="input" value={(v as string) ?? ""} onChange={(e) => set(name, e.target.value)} />;
            break;
          case "datetime":
            input = (
              <input
                id={id}
                type="datetime-local"
                className="input"
                value={toLocalInput(v)}
                onChange={(e) => set(name, e.target.value ? new Date(e.target.value).toISOString() : "")}
              />
            );
            break;
          case "actor":
            input = (
              <select id={id} className="select" value={(v as string) ?? ""} onChange={(e) => set(name, e.target.value)}>
                <option value="">—</option>
                {actors.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id} ({a.kind})
                  </option>
                ))}
              </select>
            );
            break;
          case "list":
            input = (
              <textarea
                id={id}
                className="textarea textarea-short"
                placeholder={t("form.onePerLine")}
                value={Array.isArray(v) ? v.join("\n") : ""}
                onChange={(e) =>
                  set(
                    name,
                    e.target.value
                      .split("\n")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  )
                }
              />
            );
            break;
          default:
            input = <input id={id} className="input" value={(v as string) ?? ""} onChange={(e) => set(name, e.target.value)} />;
        }
        const error = errors[name];
        const errId = `${id}-err`;
        if (error && spec.type !== "boolean")
          input = cloneElement(input as ReactElement<Record<string, unknown>>, { "aria-invalid": true, "aria-describedby": errId });
        return (
          <div className={`field${error ? " has-error" : ""}`} key={name}>
            {spec.type !== "boolean" && (
              <label htmlFor={id}>
                {label(name)} {spec.required && <span className="req">*</span>}
              </label>
            )}
            {input}
            {error && (
              <p id={errId} className="field-error">
                {error}
              </p>
            )}
            {spec.description && spec.type !== "boolean" && <span className="hint">{labels.hint(spec.description)}</span>}
          </div>
        );
      })}
    </>
  );
}
