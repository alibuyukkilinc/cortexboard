import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, stringifyFrontmatter } from "../src/store/frontmatter.js";

test("frontmatter: a round trip keeps meta and body", () => {
  const text = stringifyFrontmatter({ title: "Ödeme akışı", tags: ["iyzico", "3ds"], skipped: undefined }, "Body line\n\nSecond paragraph.");
  assert.doesNotMatch(text, /skipped/, "undefined fields are not written");
  const { meta, body } = parseFrontmatter<{ title: string; tags: string[] }>(text);
  assert.deepEqual(meta, { title: "Ödeme akışı", tags: ["iyzico", "3ds"] });
  assert.equal(body, "Body line\n\nSecond paragraph.");
});

test("frontmatter: CRLF files (a Windows editor, core.autocrlf) read the same as LF", () => {
  const lf = "---\ntitle: Kargo\nstatus: open\n---\n\nİki satır\nburada.\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  const a = parseFrontmatter(lf);
  const b = parseFrontmatter(crlf);
  assert.deepEqual(b.meta, a.meta);
  assert.equal(b.body.replace(/\r\n/g, "\n"), a.body);
});

test("frontmatter: a --- line in the body is body, not a second fence", () => {
  const text = "---\ntitle: Notes\n---\n\nAbove\n\n---\n\nBelow the rule\n";
  const { meta, body } = parseFrontmatter<{ title: string }>(text);
  assert.equal(meta.title, "Notes");
  assert.equal(body, "Above\n\n---\n\nBelow the rule");
  // And it survives being written back.
  assert.equal(parseFrontmatter(stringifyFrontmatter(meta, body)).body, body);
});

test("frontmatter: unicode and YAML-special characters in values", () => {
  const meta = { title: 'Şifre: "sıfırlama" # değil', summary: "İ ı Ğ ğ Ü ü Ş ş Ö ö Ç ç — ✓", n: "007" };
  const back = parseFrontmatter<typeof meta>(stringifyFrontmatter(meta, "x")).meta;
  assert.deepEqual(back, meta, "quoted where needed; a leading-zero string stays a string");
});

test("frontmatter: no fence means no meta, the whole text is body", () => {
  assert.deepEqual(parseFrontmatter("  just text \n"), { meta: {}, body: "just text" });
  assert.deepEqual(parseFrontmatter("---\nnot closed\n").meta, {});
});
