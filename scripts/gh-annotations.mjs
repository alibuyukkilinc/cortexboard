// node:test reporter for CI: every failing test becomes a GitHub Actions error annotation, so a red run
// shows which test failed and why on the run's page (and through the public API), not only in the log.
// Used next to the spec reporter: --test-reporter=./scripts/gh-annotations.mjs --test-reporter-destination=stdout
import { relative } from "node:path";

const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProp = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const rel = (file) => relative(process.cwd(), String(file).replace(/^file:\/\//, ""));

export default async function* annotations(source) {
  // A whole file can fail without a failing test (the process crashed after its tests, say from an
  // uncaught 'error' event). Its diagnostics and stderr are then the only clue: the last lines are kept per file.
  const stderr = new Map();
  for await (const event of source) {
    // "generated asynchronous activity after the test ended... triggered an uncaughtException" arrives here.
    if (event.type === "test:diagnostic" && /error|exception|failed/i.test(event.data.message)) {
      const key = event.data.file ?? "";
      stderr.set(key, [...(stderr.get(key) ?? []), String(event.data.message)].slice(-25));
      continue;
    }
    if (event.type === "test:stderr") {
      const key = event.data.file ?? "";
      const lines = [...(stderr.get(key) ?? []), ...String(event.data.message).split("\n")].filter(Boolean);
      stderr.set(key, lines.slice(-25));
      continue;
    }
    if (event.type !== "test:fail") continue;
    const { name, file, line, details, nesting } = event.data;
    const error = details?.error;
    // The file-level entry repeats its failing tests; report each test once.
    if (nesting === 0 && error?.failureType === "subtestsFailed") continue;
    const cause = error?.cause ?? error;
    const fileLevel = nesting === 0 && file && name === file;
    const message = [
      cause?.message ?? String(cause ?? "failed"),
      error?.failureType ? `failureType: ${error.failureType}` : "",
      // A file whose process died: the exit code says how (0xC0000005 = 3221225477 is a native crash on Windows).
      error?.exitCode != null || error?.signal
        ? `exitCode: ${error.exitCode}${error.exitCode > 255 ? ` (0x${Number(error.exitCode).toString(16).toUpperCase()})` : ""} signal: ${error.signal}`
        : "",
      cause?.expected !== undefined ? `expected: ${JSON.stringify(cause.expected)}` : "",
      cause?.actual !== undefined ? `actual: ${JSON.stringify(cause.actual)}` : "",
      String(cause?.stack ?? "")
        .split("\n")
        .slice(1, 6)
        .join("\n"),
      fileLevel || nesting === 0 ? `diagnostics and stderr (last lines):\n${(stderr.get(file) ?? stderr.get("") ?? []).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 4000);
    const where = file ? `file=${escapeProp(rel(file))},line=${line ?? 1},` : "";
    yield `::error ${where}title=${escapeProp(name)}::${escapeData(message)}\n`;
  }
}
