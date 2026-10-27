---
title: Kod yapısı ve alışkanlıklar
summary: src/{core,store,index,search,git,api,hub,mcp,util}, web/src, test/. ESM
  TypeScript 7, girdiler zod ile denetlenir, yorumlar 'neden'i anlatır. Lint
  oxlint (tip bilgili), biçim Prettier. Testler gerçek geçici projeler ve gerçek
  git depolarıyla; süre değil sayı ölçülür.
links:
  code:
    - file: test/helpers.ts
verified_at_commit: 7bf1c4478535011c15b888c81a2092e4e2225766
id: 01M34Q1CBH9Y1DPA0KSNF0G7D3
status: active
updated_by: ai-agent
updated_at: 2026-09-24T08:08:02.721Z
---

- `src/core`: iş mantığı. `src/store`: yalnızca dosya okuma/yazma (ekler dahil). `src/index`: SQLite önbelleği. `src/git`: git çağrıları ve biçim karşılaştırması. `src/hub`: ekip sunucusu. Arayüz katmanlarında mantık olmaz.
- Denetim: zod şemaları servisin yanında (`NodeInput`, `CreateItemInput`, `ActivityInput`); hatalar `CortexError(kod, mesaj, durum, ipucu)`.
- Testler: `test/*.test.ts`, node:test, tsx ile (CI derlemeden önce test eder). `test/helpers.ts`: `tempProject()` gerçek, kurulmuş bir proje açar (dil `en`, saat dilimi `UTC` sabit); `gitProject()` küçük bir kod tabanı ve gerçek commit'lerle bir git deposu açar (eskime hiçbir zaman sahte değil). CLI alt süreç olarak test edilir (`test/cli.test.ts`).
- Süre değil sayı ölç: paylaşımlı CI makinelerinde duvar saati oynar, git çağrısı ya da klasör listeleme sayısı oynamaz (`test/perf.test.ts`; `Git.calls`, `ItemStore.scans`).
- Hata düzeltirken önce testi yaz ve kırmızı gör; commit mesajına ne koruduğunu ve ölçülen önce/sonra sayısını yaz.
- Lint: `npm run lint` = oxlint `--type-aware` (typescript-eslint TypeScript 7'yi desteklemediği için; karar `01M3837TYN730SW3BRBT5YWDAX`), küçük kural seti (`.oxlintrc.json`), uyarı da hata. Biçim: `npm run format:check`, Prettier `printWidth: 160`; `.cortex/` ve Markdown biçimlenmez. Biçim süpürgeleri `.git-blame-ignore-revs`'e yazılır.
- Web: tıklanan ama düğme olamayan her şey `Pressable`/`ListRow` (`web/src/ui.tsx`); etiketler `htmlFor`/`id` ile bağlı.
- Ayrıntılı kurallar ve CI düzeni: `CONTRIBUTING.md`.
