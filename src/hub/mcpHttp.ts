import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildMcpServer } from "../mcp/server.js";
import type { McpApi } from "../mcp/client.js";
import { CortexError } from "../core/types.js";

// MCP over HTTP, so an AI that does not run on this machine (ChatGPT, a hosted agent, a teammate's tool)
// can use the same tools as a local one. Stateless: every request gets its own server and transport,
// and the agent's token decides its role and what it sees, exactly as in REST.
// The person's chat key, next to the agent's token: approvals from the AI chat (see apiFor in the hub).
export const HUMAN_KEY_HEADER = "x-cortex-human-token";

// resourceMetadata: where a client without a token finds how to get one (OAuth, src/hub/oauth.ts). A 401 names
// it in WWW-Authenticate, which is how claude.ai connectors and other OAuth clients start signing in.
export function registerMcpHttp(
  app: FastifyInstance,
  apiFor: (project: string, token: string, humanKey?: string) => McpApi,
  opts: { resourceMetadata?: (project: string) => string } = {},
): void {
  const unauthorized = (reply: FastifyReply, project: string, message: string) => {
    if (opts.resourceMetadata) reply.header("www-authenticate", `Bearer resource_metadata="${opts.resourceMetadata(project)}"`);
    return new CortexError("unauthorized", message, 401);
  };
  app.post("/mcp/p/:project", async (req, reply) => {
    const auth = req.headers.authorization ?? "";
    const { project } = req.params as { project: string };
    if (!auth.startsWith("Bearer ")) throw unauthorized(reply, project, "Send 'Authorization: Bearer <agent token>', or connect with OAuth.");
    // ?tools=full: the rarely used tools too (see FULL_ONLY); a client with a small context keeps the default core set.
    const tools = (req.query as { tools?: string }).tools === "full" ? "full" : "core";
    const key = req.headers[HUMAN_KEY_HEADER];
    let api: McpApi;
    try {
      api = apiFor(project, auth.slice(7), typeof key === "string" && key ? key : undefined);
    } catch (e) {
      // An expired OAuth token lands here too: the header tells the client to refresh or sign in again.
      if (e instanceof CortexError && e.status === 401) throw unauthorized(reply, project, e.message);
      throw e;
    }
    // Stateless HTTP cannot carry a question to the client (elicitation): with a person, questions go to the board.
    const server = buildMcpServer(api, { tools });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.hijack(); // the transport wrote the response itself
  });

  // The spec lets clients open a stream or end a session; stateless mode has neither.
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp/p/:project", async (req, reply) => {
      // Without a token, the same answer as a POST: some clients probe with GET before signing in.
      if (!(req.headers.authorization ?? "").startsWith("Bearer "))
        throw unauthorized(reply, (req.params as { project: string }).project, "Connect with a token or OAuth.");
      return reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "This endpoint is stateless: send JSON-RPC with POST." }, id: null });
    });
  }
}
