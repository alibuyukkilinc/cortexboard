import { AsyncLocalStorage } from "node:async_hooks";

// Where a human's say came from when it did not come from the board: asked in the AI chat through MCP
// elicitation (the answer comes from the client's UI, the model never sees it before it is recorded), or
// relayed by the AI quoting what the person wrote (weaker: marked unverified), or asked by the AI on the
// board and answered there from the person's own board session (board-prompt: clients that cannot ask).
export interface Via {
  channel: "chat-elicitation" | "chat-relayed" | "board-prompt";
  ai_actor: string; // the AI that asked or relayed
  session?: string; // the MCP session the answer came through
  shown_hash?: string; // sha256 of exactly what the person was shown
  verbatim?: string; // relayed only: the person's words as the AI quoted them
  unverified?: boolean; // relayed only: nobody but the AI vouches for it
  confirmed_by?: string; // relayed, then confirmed on the board by this person
}

// Set around one write made on a person's behalf; every audit entry and reply written inside it carries it.
export const provenance = new AsyncLocalStorage<Via>();

export const currentVia = (): Via | undefined => provenance.getStore();

export type RelayedMode = "accept" | "pending" | "off";

export interface ChatSettings {
  relayed: RelayedMode;
  max_batch: number;
  relayed_human_only: boolean;
}
