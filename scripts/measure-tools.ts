// Measures what `tools/list` costs a session: the JSON every MCP client sends to the model at the start.
// Usage: node --import tsx scripts/measure-tools.ts [core|full]  (default full)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { localApi } from "../src/mcp/client.js";
import { buildMcpServer } from "../src/mcp/server.js";
import { tempProject } from "../test/helpers.js";

const p = tempProject();
const api = await localApi(p.cortex, p.ai, { human: p.human });
const server = buildMcpServer(api, { tools: process.argv[2] === "core" ? "core" : "full" });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "measure", version: "1" }, { capabilities: { elicitation: { form: {} } } });
await Promise.all([server.connect(a), client.connect(b)]);
const { tools } = await client.listTools();
const rows = tools.map((t) => ({ name: t.name, bytes: JSON.stringify(t).length })).sort((x, y) => y.bytes - x.bytes);
const total = JSON.stringify(tools).length;
for (const r of rows) console.log(`${String(r.bytes).padStart(6)}  ${r.name}`);
console.log(`${tools.length} tools, ${total} bytes, ~${Math.round(total / 4)} tokens`);
await client.close();
await api.close();
p.cleanup();
