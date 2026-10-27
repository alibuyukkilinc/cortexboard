// Draws the report from window.BENCH (data.js). Plain SVG and DOM, no libraries.
(function () {
  "use strict";
  const B = window.BENCH || { runs: [], tasks: [] };
  const $ = (s) => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const SVG = "http://www.w3.org/2000/svg";
  const s = (tag, attrs) => {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    return n;
  };

  const ARMS = [
    { id: "cortex", label: "Cortex ile" },
    { id: "baseline", label: "Cortex'siz (kod + git)" },
  ];
  const armLabel = (a) => ARMS.find((x) => x.id === a)?.label ?? a;

  function modelName(r) {
    const known = {
      "claude-haiku-4-5-20251001": "Haiku 4.5",
      "claude-sonnet-5-5": "Sonnet 5.5",
      "claude-opus-5-5": "Opus 5.5",
      "claude-fable-5-1": "Fable 5.1",
    };
    const id = r.model_resolved ?? r.model;
    let n = known[id] ?? (id === "default" ? (r.agent === "codex" ? "GPT (Codex varsayılanı)" : "Claude varsayılanı") : id);
    if (/^gpt-/i.test(n)) {
      const [, ver, ...rest] = n.split("-"); // gpt-6-astra → GPT-6 Astra
      n = [`GPT-${ver}`, ...rest.map((w) => w[0].toUpperCase() + w.slice(1))].join(" ");
    }
    if (r.agent === "opencode") n = `OpenCode · ${id.replace(/^[^/]+\//, "")}`; // the harness, then the model it drove
    return r.effort ? `${n} · ${r.effort}` : n;
  }
  const family = (r) => (r.agent === "opencode" ? "OpenCode" : r.agent === "codex" ? "OpenAI" : "Anthropic");

  // Numbers, Turkish style.
  const nf = (d) => new Intl.NumberFormat("tr-TR", { maximumFractionDigits: d, minimumFractionDigits: d });
  const f0 = nf(0).format;
  const f1 = nf(1).format;
  const f2 = nf(2).format;
  const kTok = (v) => `${f0(v / 1000)}K`;
  const mins = (ms) => `${f1(ms / 60000)} dk`;
  const pct = (v) => `%${f0(v * 100)}`;

  // --- models: one row per model, each with a cortex and a baseline run (either may be missing)
  const runs = B.runs || [];
  const models = [];
  for (const r of runs) {
    const key = `${r.agent}|${r.model}|${r.effort ?? ""}`;
    let m = models.find((x) => x.key === key);
    if (!m) models.push((m = { key, name: modelName(r), family: family(r), arms: {} }));
    m.arms[r.arm] = r;
  }
  const order = ["Haiku", "Sonnet", "Opus", "Fable"];
  models.sort((a, b) => (a.family === b.family ? rank(a.name) - rank(b.name) : a.family.localeCompare(b.family)));
  function rank(n) {
    const i = order.findIndex((o) => n.startsWith(o));
    return i < 0 ? 99 : i;
  }

  // --- header meta
  const fx = B.fixture;
  $("#meta").textContent = [
    `Tur ${B.round ?? 10}`,
    fx ? `depo ${String(fx.repo_head).slice(0, 7)} · cortexboard ${fx.cortex_version}` : null,
    B.generated_at ? `üretildi ${new Date(B.generated_at).toLocaleString("tr-TR")}` : null,
    `${runs.length} koşu`,
  ]
    .filter(Boolean)
    .join(" · ");
  $("#foot").textContent = "bench/report · node bench/report/build.mjs ile yeniden üretilir. Tüm sonuçlar olduğu gibi yazılır, Cortex'in aleyhine olanlar da.";

  if (!runs.length) $("#empty").hidden = false;

  // --- legend
  for (const l of document.querySelectorAll("[data-legend]")) {
    for (const a of ARMS) l.append(el("span", {}, el("i", { class: `bg-${a.id}` }), a.label));
  }

  // --- tooltip
  const tip = $("#tip");
  function showTip(evt, title, rows) {
    tip.innerHTML = "";
    tip.append(el("b", {}, title));
    for (const [k, v] of rows) tip.append(el("div", { class: "row" }, el("span", {}, k), el("span", {}, v)));
    tip.hidden = false;
    const x = Math.min(evt.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min(evt.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  const hideTip = () => (tip.hidden = true);

  const tipRows = (r) => [
    ["Puan", `${f1(r.score)} / ${r.max}`],
    ["Token", kTok(r.tokens)],
    ["Süre", mins(r.wall_ms)],
    ["Araç çağrısı", `${r.tool_calls} (${r.tool_errors} hatalı)`],
    ...(r.cost_usd != null ? [["Maliyet", `$${f2(r.cost_usd)}`]] : []),
  ];

  // --- grouped horizontal bars: one group per model, one bar per arm
  function bars(id, value, fmt, opts = {}) {
    const host = $(id);
    if (!models.length) return;
    const W = 560;
    const labelW = 150;
    const barH = 14;
    const gap = 2;
    const groupGap = 16;
    const groupH = ARMS.length * barH + (ARMS.length - 1) * gap;
    const H = models.length * groupH + (models.length - 1) * groupGap + 24;
    // Round tick steps (1, 2, 2.5, 5 × 10^n) so the axis reads 0, 50K, 100K… rather than 0, 43K, 86K.
    const top = opts.max ?? Math.max(1e-9, ...runs.map(value).filter((v) => v != null));
    const raw = top / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = opts.max ? opts.max / 4 : [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw);
    const ticks = Math.ceil(top / step - 1e-9);
    const max = step * ticks;
    const plotW = W - labelW - 60;
    const x = (v) => labelW + (plotW * v) / max;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.aria || "" });
    for (let i = 0; i <= ticks; i++) {
      const v = step * i;
      const gx = x(v);
      svg.append(s("line", { x1: gx, x2: gx, y1: 0, y2: H - 20, class: i === 0 ? "axis" : "gridline" }));
      const t = s("text", { x: gx, y: H - 4, "text-anchor": "middle" });
      t.textContent = opts.tick ? opts.tick(v) : fmt(v);
      svg.append(t);
    }
    models.forEach((m, gi) => {
      const gy = gi * (groupH + groupGap);
      const name = s("text", { x: 0, y: gy + groupH / 2 + 4, class: "cat" });
      name.textContent = m.name;
      svg.append(name);
      ARMS.forEach((a, ai) => {
        const r = m.arms[a.id];
        const y = gy + ai * (barH + gap);
        if (!r) {
          const t = s("text", { x: labelW + 4, y: y + barH - 3 });
          t.textContent = "tamamlanmadı";
          svg.append(t);
          return;
        }
        const v = value(r) ?? 0;
        const w = Math.max(2, x(v) - labelW);
        // bar with a rounded data end, square at the baseline
        const rr = Math.min(4, w / 2);
        const d = `M${labelW},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${barH - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(w - rr)} z`;
        const bar = s("path", { d, class: `bar fill-${a.id}` });
        svg.append(bar);
        const t = s("text", { x: labelW + w + 6, y: y + barH - 3, class: "val" });
        t.textContent = fmt(v);
        svg.append(t);
        const hit = s("rect", { x: 0, y: y - 1, width: W, height: barH + 2, class: "hit" });
        hit.addEventListener("mousemove", (e) => {
          bar.classList.add("on");
          showTip(e, `${m.name} · ${a.label}`, tipRows(r));
        });
        hit.addEventListener("mouseleave", () => {
          bar.classList.remove("on");
          hideTip();
        });
        svg.append(hit);
      });
    });
    host.append(svg);
  }

  bars(
    "#c-score",
    (r) => r.score,
    (v) => f0(v),
    { max: 80, aria: "Model başına puan, Cortex ile ve Cortex'siz" },
  );
  bars("#c-tokens", (r) => r.tokens, kTok, { aria: "Model başına toplam token" });
  bars("#c-time", (r) => r.wall_ms, mins, { aria: "Model başına toplam süre" });
  bars(
    "#c-eff",
    (r) => r.points_per_100k,
    (v) => f1(v),
    { aria: "100 bin token başına puan" },
  );
  bars("#c-waste", (r) => r.wasted_ms, mins, { aria: "Düşük puanlı görevlerde harcanan süre" });

  // --- KPIs: what Cortex changed, averaged over models that ran both arms
  const paired = models.filter((m) => m.arms.cortex && m.arms.baseline);
  const kpis = $("#kpis");
  if (runs.length) {
    const best = runs.reduce((a, b) => (b.score > a.score ? b : a));
    const avg = (f) => paired.reduce((s2, m) => s2 + f(m), 0) / (paired.length || 1);
    const rel = (f) => avg((m) => f(m.arms.cortex) / Math.max(1e-9, f(m.arms.baseline)) - 1);
    const kpi = (label, value, note, cls) =>
      kpis.append(
        el(
          "div",
          { class: "kpi" },
          el("div", { class: "label" }, label),
          el("div", { class: `value ${cls || ""}` }, value),
          el("div", { class: "note" }, note),
        ),
      );
    kpi("En yüksek puan", `${f1(best.score)} / ${best.max}`, `${modelName(best)} · ${armLabel(best.arm)}`);
    if (paired.length) {
      const dScore = avg((m) => m.arms.cortex.score - m.arms.baseline.score);
      const dTok = rel((r) => r.tokens);
      const dTime = rel((r) => r.wall_ms);
      const sign = (v, d = 0) => (Number(nf(d).format(Math.abs(v)).replace(",", ".")) === 0 ? "±" : v > 0 ? "+" : "−") + nf(d).format(Math.abs(v));
      kpi("Cortex'in puan etkisi", `${sign(dScore, 1)} puan`, `${paired.length} modelin ortalaması, 80 üzerinden`, dScore >= 0 ? "up" : "down");
      kpi("Token farkı", `${sign(dTok * 100)}%`, "Cortex ile, Cortex'siz koşuya göre", dTok <= 0 ? "up" : "down");
      kpi("Süre farkı", `${sign(dTime * 100)}%`, "Cortex ile, Cortex'siz koşuya göre", dTime <= 0 ? "up" : "down");
    }
  }

  // --- heatmap: rows = runs (model × arm), columns = tasks
  const tasks = B.tasks || [];
  const seq = (v) => `var(--seq-${Math.min(5, Math.round(v * 5))})`;
  const inkOn = (v) => (v >= 0.6 ? "#ffffff" : "var(--ink)");
  if (runs.length) {
    const tbl = el("table", { class: "heat" });
    tbl.append(el("thead", {}, el("tr", {}, el("th", {}, ""), ...tasks.map((t) => el("th", { title: t.title }, t.id)), el("th", {}, "Toplam"))));
    const body = el("tbody");
    for (const m of models)
      for (const a of ARMS) {
        const r = m.arms[a.id];
        if (!r) continue;
        const tr = el("tr", {}, el("th", {}, el("span", { class: `arm-dot bg-${a.id}` }), `${m.name} · ${a.id === "cortex" ? "Cortex" : "kod + git"}`));
        for (const t of tasks) {
          const x = r.tasks.find((y) => y.id === t.id);
          if (!x) {
            tr.append(el("td", { class: "total" }, "–"));
            continue;
          }
          const v = x.max ? x.got / x.max : 0;
          const td = el(
            "td",
            { tabindex: "0", style: `background:${seq(v)};color:${inkOn(v)}`, "aria-label": `${m.name}, ${a.label}, ${t.id}: ${x.got} / ${x.max}` },
            x.voided ? `${f0(x.got)} ⊘` : x.outside?.length ? `${f0(x.got)} ·` : f0(x.got),
          );
          const open = () => detail(m, a, r, t, x, td);
          td.addEventListener("click", open);
          td.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open()));
          td.addEventListener("mousemove", (e) =>
            showTip(e, `${t.id} ${t.title}`, [
              ["Puan", `${f1(x.got)} / ${x.max}`],
              ["Süre", `${f0(x.wall_ms / 1000)} sn`],
              ["Token", kTok(x.tokens)],
              ["Araç çağrısı", `${x.tool_calls} (${x.tool_errors} hatalı)`],
              ["Zorluk (ajan)", x.difficulty ?? "–"],
            ]),
          );
          td.addEventListener("mouseleave", hideTip);
          tr.append(td);
        }
        tr.append(el("td", { class: "total" }, `${f0(r.score)}`));
        body.append(tr);
      }
    tbl.append(body);
    $("#c-heat").append(tbl);
  }

  function detail(m, a, r, t, x, td) {
    document.querySelectorAll(".heat td.sel").forEach((n) => n.classList.remove("sel"));
    td.classList.add("sel");
    const d = $("#detail");
    d.hidden = false;
    d.innerHTML = "";
    d.append(
      el("h3", {}, `${t.id} · ${t.title} — ${m.name}, ${a.label}`),
      el(
        "div",
        { class: "facts" },
        el("span", {}, `Puan ${f1(x.got)} / ${x.max}`),
        el("span", {}, `${f0(x.wall_ms / 1000)} sn`),
        el("span", {}, `${kTok(x.tokens)} token`),
        el("span", {}, `${x.tool_calls} araç çağrısı, ${x.tool_errors} hatalı`),
        x.cortex_calls ? el("span", {}, `${x.cortex_calls} Cortex çağrısı`) : null,
        x.cost_usd != null ? el("span", {}, `$${f2(x.cost_usd)}`) : null,
        el("span", {}, `zorluk: ${x.difficulty ?? "–"}, eminlik: ${x.confidence ?? "–"}`),
        x.error ? el("span", { class: "down" }, "oturum hatası / zaman aşımı") : null,
        x.voided ? el("span", { class: "down" }, "geçersiz: test kopyasının dışından gerçek projenin bilgisini okudu") : null,
        !x.voided && x.outside?.length ? el("span", {}, "test kopyasının dışına baktı (ev dizini), bilgi okumadı") : null,
      ),
      el(
        "ul",
        { class: "checks" },
        (x.checks || []).map((c) =>
          el(
            "li",
            {},
            el("span", { class: c.got >= c.points ? "ok" : "no", "aria-hidden": "true" }, c.got >= c.points ? "✓" : c.got > 0 ? "◐" : "✗"),
            el("span", {}, `${c.label} — ${f1(c.got)}/${c.points}`, c.note ? el("small", {}, ` (${c.note.split("\n")[0].slice(0, 120)})`) : null),
          ),
        ),
      ),
      el("pre", { class: "answer" }, x.answer || "(cevap yok)"),
    );
    d.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // --- sortable table of every run
  const cols = [
    { k: "model", l: "Model", v: (r) => modelName(r), f: (v) => v, left: true },
    {
      k: "arm",
      l: "Kol",
      v: (r) => r.arm,
      f: (v, r) => el("span", { class: "pill" }, el("i", { class: `bg-${r.arm}` }), r.arm === "cortex" ? "Cortex" : "kod + git"),
      left: true,
    },
    { k: "score", l: "Puan /80", v: (r) => r.score, f: f1 },
    { k: "tokens", l: "Token", v: (r) => r.tokens, f: kTok },
    { k: "out", l: "Çıktı token", v: (r) => r.output_tokens, f: kTok },
    { k: "wall", l: "Süre", v: (r) => r.wall_ms, f: mins },
    { k: "ppk", l: "Puan/100K tok", v: (r) => r.points_per_100k, f: f1 },
    { k: "spp", l: "Sn/puan", v: (r) => r.sec_per_point, f: (v) => (v == null ? "–" : f1(v)) },
    { k: "calls", l: "Çağrı", v: (r) => r.tool_calls, f: f0 },
    { k: "err", l: "Hatalı", v: (r) => r.tool_errors, f: f0 },
    { k: "ctx", l: "Cortex çağrısı", v: (r) => r.cortex_calls, f: f0 },
    { k: "waste", l: "Kayıp süre", v: (r) => r.wasted_ms, f: mins },
    {
      k: "esc",
      l: "Dışarı çıkış",
      v: (r) => (r.voided ?? 0) * 10 + (r.peeked ?? 0),
      f: (v, r) => (r.voided ? `${r.voided} geçersiz` : r.peeked ? `${r.peeked} baktı` : "–"),
    },
    { k: "cost", l: "Maliyet", v: (r) => r.cost_usd, f: (v) => (v == null ? "–" : `$${f2(v)}`) },
    {
      k: "diff",
      l: "Zor/orta/kolay",
      v: (r) => r.difficulty.zor * 100 + r.difficulty.orta,
      f: (v, r) => `${r.difficulty.zor}/${r.difficulty.orta}/${r.difficulty.kolay}`,
    },
    { k: "conf", l: "Eminlik", v: (r) => r.confidence, f: (v) => (v == null ? "–" : f0(v)) },
  ];
  let sort = { k: "score", dir: -1 };
  function drawTable() {
    const t = $("#t-runs");
    t.className = "data";
    t.innerHTML = "";
    const head = el(
      "tr",
      {},
      cols.map((c) =>
        el(
          "th",
          {
            class: c.left ? "l" : null,
            scope: "col",
            tabindex: "0",
            "aria-sort": sort.k === c.k ? (sort.dir > 0 ? "ascending" : "descending") : null,
            onclick: () => {
              sort = { k: c.k, dir: sort.k === c.k ? -sort.dir : -1 };
              drawTable();
            },
            onkeydown: (e) => e.key === "Enter" && e.target.click(),
          },
          c.l,
        ),
      ),
    );
    const col = cols.find((c) => c.k === sort.k);
    const rows = [...runs].sort((a, b) => {
      const x = col.v(a);
      const y = col.v(b);
      return (typeof x === "string" ? String(x).localeCompare(y) : (x ?? -1) - (y ?? -1)) * sort.dir;
    });
    t.append(
      el("thead", {}, head),
      el(
        "tbody",
        {},
        rows.map((r) =>
          el(
            "tr",
            {},
            cols.map((c) => el("td", { class: c.left ? "l" : null }, c.f(c.v(r), r))),
          ),
        ),
      ),
    );
  }
  if (runs.length) drawTable();

  // --- what to keep in mind about this round
  if (B.notes?.length) {
    $("#notes-card").hidden = false;
    for (const n of B.notes) $("#notes").append(el("li", {}, n));
  }

  // --- tasks and answer key
  const tk = $("#tasks");
  for (const t of tasks)
    tk.append(
      el(
        "details",
        { class: "task" },
        el("summary", {}, `${t.id} · ${t.title}`, el("span", {}, `${t.kind} · ${t.max} puan`)),
        el("p", {}, t.prompt),
        el("p", { class: "k" }, el("b", {}, "Anahtar: "), t.key),
      ),
    );

  // --- earlier rounds (docs/BENCHMARKS.md)
  const HIST = [
    [1, "2026-09-24", "Kodda/CHANGELOG'da da olan 5 bilgi", "4,75 → 5,0 / 5", "63,1K → 67,1K", "9 → 13", "39 → 26 sn"],
    [2, "2026-09-24", '5 "neden / kim karar verdi / ne açık"', "2,5 → 4,9 / 5", "62,5K → 68,3K", "7 → 20", "41 → 43 sn"],
    [3, "2026-09-24", "2. tur, araç değişikliklerinden sonra", "2,5 → 4,97 / 5", "62,5K → 69,4K", "7 → 12", "41 → 35 sn"],
    [4, "2026-09-24", "Tek büyük tasarım görevi", "11,5 → 11,6 / 12", "88,1K → 90,1K", "9 → 27", "82 → 91 sn"],
    [5, "2026-09-24", "Yalnız arama: anahtar kelime vs. hibrit", "6 → 6 / 6", "68,2K → 66,3K", "11,5 → 11", "19 → 19 sn"],
    [6, "2026-09-24", "Büyük kod tabanı, zayıf model, tek soru", "14,5 → 23,5 / 26", "55,5K → 3,9K", "8 → 7", "–"],
    [7, "2026-09-28", '5 "ne" + 5 "neden", büyük özel kod tabanı', "8,25 → 8,5 / 10", "198,3K → 184,9K", "49 → 34", "165 → 111 sn"],
    [8, "2026-09-28", "7. tur, bilgi düzeltildikten sonra", "8,75 → 10 / 10", "196,1K → 158,1K", "44 → 17", "173 → 73 sn"],
    [9, "2026-09-29", "Bu reponun son değişiklikleri, iki model boyu", "7,0 → 9,25 / 10", "77,0K → 81,8K", "24 → 12", "63 → 49 sn"],
  ];
  const h = $("#t-hist");
  h.className = "data";
  h.append(
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        ["Tur", "Tarih", "Soru tipi", "Doğruluk", "Token", "Çağrı", "Süre"].map((x, i) => el("th", { class: i < 3 ? "l" : null, scope: "col" }, x)),
      ),
    ),
    el(
      "tbody",
      {},
      HIST.map((row) =>
        el(
          "tr",
          {},
          row.map((c, i) => el("td", { class: i < 3 ? "l" : null }, String(c))),
        ),
      ),
    ),
  );

  // --- theme toggle (a per-viewer convenience; the page works without storage)
  const root = document.documentElement;
  function setTheme(t) {
    if (t === "auto") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", t);
    document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === t)));
    try {
      localStorage.setItem("bench-theme", t);
    } catch {}
  }
  document.querySelectorAll("[data-theme-set]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.themeSet)));
  try {
    const saved = localStorage.getItem("bench-theme");
    if (saved) setTheme(saved);
  } catch {}
})();
