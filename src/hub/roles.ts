import type { Perm } from "../api/access.js";
import type { ApprovalPolicy } from "../core/types.js";

// Ready-made project roles. Humans and AI agents have separate sets: an AI can never approve, edit rules or
// manage members, whatever role it is given.
export const HUMAN_ROLES = ["owner", "admin", "member", "viewer"] as const;
export const AI_ROLES = ["reader", "contributor", "trusted"] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];
export type AiRole = (typeof AI_ROLES)[number];
export type Role = HumanRole | AiRole;

const ALL: Perm[] = ["read", "ask", "write_items", "write_knowledge", "delete_knowledge", "approve", "edit_rules", "manage_members", "reports", "log_activity"];

export const ROLE_PERMS: Record<Role, Perm[]> = {
  owner: ALL,
  admin: ALL,
  member: ["read", "ask", "write_items", "write_knowledge", "approve", "reports", "log_activity"],
  viewer: ["read", "ask", "reports"],
  reader: ["read"],
  contributor: ["read", "ask", "write_items", "write_knowledge", "log_activity"], // knowledge writes become drafts
  trusted: ["read", "ask", "write_items", "write_knowledge", "log_activity"], // knowledge writes apply directly
};

// Per-role approval overrides handed to the core (see Actor.policy).
export const ROLE_POLICY: Partial<Record<Role, Record<string, ApprovalPolicy>>> = {
  trusted: { node: "auto" },
};

export function isRoleFor(kind: "human" | "ai", role: string): role is Role {
  return kind === "human" ? (HUMAN_ROLES as readonly string[]).includes(role) : (AI_ROLES as readonly string[]).includes(role);
}

export const DEFAULT_ROLE = { human: "member", ai: "contributor" } as const;
