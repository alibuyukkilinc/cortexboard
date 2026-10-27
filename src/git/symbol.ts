// This is deliberately a small declaration scanner, not a language parser. Ambiguous or unsupported
// declarations fall back to file-level tracking so we never silently trust a guessed symbol.
export function symbolBody(source: string, name: string): string | null {
  if (!/^[\w$]+$/.test(name)) return null;
  const masked = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g, (s) =>
    s.startsWith("/") ? s.replace(/[^\r\n]/g, " ") : "x".repeat(s.length),
  );
  const escaped = name.replace(/\$/g, "\\$");
  const declaration = new RegExp(`^[ \\t]*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(function\\s*\\*?|class|const|let|var)\\s+${escaped}(?![\\w$])`, "gm");
  const matches = [...masked.matchAll(declaration)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const start = match.index;
  const variable = /^(const|let|var)$/.test(match[1]);
  const stack: string[] = [];
  let body = false;
  let assigned = false;
  for (let i = start + match[0].length; i < masked.length; i++) {
    const c = masked[i];
    // Regex literals can contain braces. Without a parser, prefer a conservative file-level result.
    if (c === "/" || c === "`" || (c === "<" && !stack.length)) return null;
    if (c === "=" && !stack.length) assigned = true;
    if ("({[".includes(c)) {
      if (c === "{" && !stack.length) body = true;
      stack.push(c);
    } else if (")}]".includes(c)) {
      if (stack.pop() !== ({ ")": "(", "}": "{", "]": "[" } as Record<string, string>)[c]) return null;
      if (!variable && body && !stack.length) {
        // An object return type is followed by the actual body; do not mistake the type for the body.
        if (
          masked
            .slice(i + 1)
            .trimStart()
            .startsWith("{")
        )
          continue;
        if (/^[|&\[]/.test(masked.slice(i + 1).trimStart())) return null;
        return source.slice(start, i + 1).trim();
      }
    } else if (!stack.length && variable && assigned && (c === ";" || c === "\n")) {
      if (c === "\n" && /[=>(,.:?&|+*-]\s*$/.test(masked.slice(start, i))) continue;
      if (c === "\n" && /^[.?(\[+*|&]/.test(masked.slice(i + 1).trimStart())) return null;
      return source.slice(start, i + (c === ";" ? 1 : 0)).trim();
    } else if (!stack.length && c === ";") return null;
  }
  return variable && assigned && !stack.length ? source.slice(start).trim() : null;
}
