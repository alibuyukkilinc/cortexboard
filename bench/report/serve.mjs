// Serves the report on http://localhost:4790 (the page also opens straight from disk; this is for browsers
// and previews that do not run file:// pages).   node bench/report/serve.mjs [folder] [--port 4790]
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const portAt = argv.indexOf("--port");
const port = portAt >= 0 ? Number(argv[portAt + 1]) : 4790;
const root = resolve(argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--port") ?? fileURLToPath(new URL(".", import.meta.url)));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[\\/]+/, "") || "index.html";
  const file = join(root, path);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`report: http://localhost:${port} (${root})`));
