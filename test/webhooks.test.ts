import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { matches, sign } from "../src/core/webhooks.js";
import { tempProject } from "./helpers.js";

// A receiver on localhost that records what arrives.
async function receiver(status = 200) {
  const got: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  return { got, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function configure(root: string, hooks: object[], secrets: Record<string, string> = {}) {
  const cfg = join(root, ".cortex", "cortex.config.yaml");
  writeFileSync(cfg, YAML.stringify({ ...YAML.parse(readFileSync(cfg, "utf8")), webhooks: hooks }));
  const sec = join(root, ".cortex", ".secrets.yaml");
  writeFileSync(sec, YAML.stringify({ ...YAML.parse(readFileSync(sec, "utf8")), webhooks: secrets }));
}

test("webhooks: event filter", () => {
  assert.ok(matches(undefined, "item.created"));
  assert.ok(matches(["item.*"], "item.replied"));
  assert.ok(!matches(["item.*"], "draft.proposed"));
  assert.ok(matches(["draft.proposed", "code_change"], "code_change"));
});

test("webhooks: activity entries are POSTed, signed, and filtered per hook", async () => {
  const all = await receiver();
  const itemsOnly = await receiver();
  const t = tempProject();
  try {
    configure(
      t.root,
      [
        { name: "all", url: all.url },
        { name: "items", url: itemsOnly.url, events: ["item.*"] },
      ],
      { all: "s3cret" },
    );
    t.cortex.project.config.webhooks = YAML.parse(readFileSync(join(t.root, ".cortex", "cortex.config.yaml"), "utf8")).webhooks;

    t.cortex.activity.log(t.ai, { action: "code_change", summary: "Rate-limit login", why: "Brute force seen in logs" });
    t.cortex.items.create(t.human, { type: "note", title: "Staging resets on Mondays" });
    await t.cortex.webhooks.idle();

    assert.deepEqual(
      all.got.map((g) => g.headers["x-cortex-event"]),
      ["code_change", "item.created"],
    );
    assert.deepEqual(
      itemsOnly.got.map((g) => g.headers["x-cortex-event"]),
      ["item.created"],
    );

    const first = all.got[0]!;
    const payload = JSON.parse(first.body) as { event: string; project: string; entry: { summary: string; why: string; actor: string } };
    assert.equal(payload.entry.summary, "Rate-limit login");
    assert.equal(payload.entry.why, "Brute force seen in logs");
    assert.equal(payload.entry.actor, "ai-agent");
    assert.equal(first.headers["x-cortex-signature"], sign("s3cret", first.body), "signed with the hook's secret");
    assert.equal(itemsOnly.got[0]!.headers["x-cortex-signature"], undefined, "no secret, no signature");
  } finally {
    t.cleanup();
    await all.close();
    await itemsOnly.close();
  }
});

test("webhooks: a failing endpoint never fails the write", async () => {
  const broken = await receiver(400);
  const t = tempProject();
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => errors.push(String(m));
  try {
    t.cortex.project.config.webhooks = [
      { name: "down", url: "http://127.0.0.1:9/nothing-listens-here" },
      { name: "bad", url: broken.url },
    ];
    const r = t.cortex.items.create(t.human, { type: "note", title: "Still saved" });
    assert.equal(r.applied, true);
    await t.cortex.webhooks.idle();
    assert.ok(errors.some((e) => e.includes("webhook down")));
    assert.ok(errors.some((e) => e.includes("webhook bad: 400")));
    assert.equal(broken.got.length, 1, "a 4xx is not retried");
  } finally {
    console.error = orig;
    t.cleanup();
    await broken.close();
  }
});
