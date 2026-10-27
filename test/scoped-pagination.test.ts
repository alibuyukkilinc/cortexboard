import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initProject } from "../src/core/init.js";
import { buildAccess } from "../src/hub/access.js";
import { hashPassword } from "../src/hub/crypto.js";
import { Hub, HUB_COOKIE, buildHubServer } from "../src/hub/server.js";
import { HubStore } from "../src/hub/store.js";
import { tempProject } from "./helpers.js";

// A member who sees 20 of 60 items must page through exactly those 20: full pages, a true total,
// no repeats and no gaps. Filtering after LIMIT gave short pages and a total counting hidden items.
test("paging as a member who sees a third of the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "cortex-scope-"));
  const store = HubStore.init(join(root, "hub"), { org: "Acme", host: "127.0.0.1", port: 4747 });
  const app = buildHubServer(new Hub(store));
  try {
    const dir = join(root, "shop");
    initProject(dir, "shop", { language: "en", timezone: "UTC", bootstrapTask: false });
    store.addProject({ id: "shop", name: "shop", path: dir });
    const admin = store.createUser({ email: "ada@example.com", name: "Ada", org_admin: true });
    const dev = store.createUser({ email: "fe@example.com", name: "Fe" });
    store.setPassword(admin.id, await hashPassword("correct-horse-1"));
    store.setPassword(dev.id, await hashPassword("correct-horse-2"));
    store.setMember("shop", dev.id, { role: "member", branches: ["front"] }); // "frontx" must not pass as being under "front"

    const login = async (email: string, password: string) =>
      (await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } })).cookies.find((c) => c.name === HUB_COOKIE)!.value;
    const adminCookie = await login("ada@example.com", "correct-horse-1");
    const devCookie = await login("fe@example.com", "correct-horse-2");
    const as = (cookie: string) => ({ cookie: `${HUB_COOKIE}=${cookie}`, "x-cortex-csrf": "1" });

    for (const b of ["front", "frontx"]) {
      const r = await app.inject({ method: "PUT", url: `/api/p/shop/node/${b}`, headers: as(adminCookie), payload: { path: b, title: b, summary: b } });
      assert.ok(r.statusCode < 300, r.body);
    }
    // Interleaved, so hidden and visible items alternate in the sort order: 20 in the member's branch, 40 elsewhere.
    // The first six wait on @humans, which every person sees wherever they are filed: 24 visible in total.
    const visible = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const path = i % 3 === 0 ? "front" : i % 3 === 1 ? "backend" : "frontx";
      const r = await app.inject({
        method: "POST",
        url: "/api/p/shop/items",
        headers: as(adminCookie),
        payload: { type: "task", title: `Task ${i}`, category_path: path, ...(i < 6 ? { assignee: "@humans" } : {}) },
      });
      assert.equal(r.statusCode, 201, r.body);
      if (path === "front" || i < 6) visible.add(r.json().id);
    }
    const seen: string[] = [];
    let cursor: string | null = "0";
    let pages = 0;
    while (cursor !== null) {
      const r = (await app.inject({ url: `/api/p/shop/items?limit=10&cursor=${cursor}`, headers: as(devCookie) })).json();
      assert.equal(r.total, 24, "the total counts only what this member can see");
      if (r.next_cursor !== null) assert.equal(r.items.length, 10, "every page but the last is full");
      seen.push(...r.items.map((i: { id: string }) => i.id));
      cursor = r.next_cursor;
      assert.ok(++pages <= 4, "no endless paging");
    }
    assert.equal(pages, 3);
    assert.equal(new Set(seen).size, seen.length, "no repeats");
    assert.deepEqual(new Set(seen), visible, "no gaps, nothing hidden leaks in");

    const inbox = (await app.inject({ url: "/api/p/shop/inbox", headers: as(devCookie) })).json();
    assert.equal(inbox.count, 6, "all six wait on @humans");
    assert.ok(inbox.items.every((i: { id: string }) => visible.has(i.id)));

    // The admin still sees all 60.
    assert.equal((await app.inject({ url: "/api/p/shop/items?limit=10", headers: as(adminCookie) })).json().total, 60);
  } finally {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// The SQL filter and the in-memory rule are two spellings of one rule; check them against each other.
test("itemSql agrees with seesItem for every scope", () => {
  const t = tempProject();
  try {
    const c = t.cortex;
    for (const b of ["front", "frontx", "backend"]) c.putNode(t.human, { path: b, title: b, summary: b });
    c.putNode(t.human, { path: "front/cart", title: "cart", summary: "cart" });
    const make = (title: string, category_path: string | undefined, author: typeof t.human, assignee?: string) =>
      c.items.create(author, { type: "task", title, ...(category_path ? { category_path } : {}), ...(assignee ? { assignee } : {}) });
    make("a", "front", t.human);
    make("b", "front/cart", t.human);
    make("c", "frontx", t.human);
    make("d", "backend", t.human, "ai-agent");
    make("e", undefined, t.ai);
    make("f", "backend", t.human, "@ai");
    make("g", "backend", t.human, "@humans");

    const all = c.items.list({ limit: 500 }).items;
    const members = [
      { principal: "ai-agent", kind: "ai" as const, role: "contributor" as const, scope: "own" as const, branches: [] },
      { principal: "ai-agent", kind: "ai" as const, role: "contributor" as const, scope: "all" as const, branches: ["front"] },
      { principal: "someone", kind: "human" as const, role: "member" as const, scope: "all" as const, branches: ["front", "backend"] },
      { principal: "someone", kind: "human" as const, role: "member" as const, scope: "own" as const, branches: ["front"] },
      { principal: "someone", kind: "human" as const, role: "member" as const, scope: "all" as const, branches: [] },
    ];
    for (const m of members) {
      const access = buildAccess(m);
      const bySql = new Set(c.items.list({ limit: 500, visible: access.itemSql() }).items.map((i) => i.id));
      const byRule = new Set(all.filter((i) => access.seesItem(i)).map((i) => i.id));
      assert.deepEqual(bySql, byRule, JSON.stringify(m));
    }
  } finally {
    t.cleanup();
  }
});
