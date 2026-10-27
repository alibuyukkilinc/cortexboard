---
title: Çalıştırma, derleme ve yayın
summary: "Tek proje yerelde: `cortexboard start` 127.0.0.1:4747. Derleme tsc +
  vite → dist/. CI: 3 OS × Node 22.16/24 (typecheck, test, test:web, build,
  smoke; lint bir ayakta) + ayrı Ubuntu `e2e` işi (Playwright + axe). Yayın:
  v*.*.* etiketi → npm provenance. Paket `cortexboard`."
links:
  code:
    - file: package.json
    - file: tsconfig.json
    - file: tsconfig.test.json
    - file: vite.config.ts
    - file: vitest.config.ts
    - file: playwright.config.ts
    - file: .github/workflows/ci.yml
    - file: .github/workflows/release.yml
    - file: scripts/smoke.mjs
    - file: scripts/release-notes.mjs
verified_at_commit: 75da85c3deb077777464a3da56cb18a8d26c4973
id: 01M34Q1CBEMJA6S58G199HVFBQ
status: active
updated_by: ai-agent
updated_at: 2026-09-27T11:48:51.485Z
---

- Node 22.16 veya üstü gerekir (node:sqlite'ın FTS5'li ilk sürümü). Veritabanı sunucusu, Docker veya API anahtarı gerekmez.
- Komutlar:
  - `npm run build`
  - `npm test`: sunucu, node:test + tsx
  - `npm run test:web`: arayüz, Vitest; bkz. `frontend/quality`
  - `npm run e2e`: Playwright; önce build gerekir
  - `npm run typecheck`: sunucu, web ve `tsconfig.test.json` ile testler/e2e/betikler
  - `npm run lint`: oxlint, tip bilgili, uyarı da hata; `src web/src web/test e2e scripts test`
  - `npm run format:check`: Prettier
  - `npm run seed:large -- <klasör>`: ölçüm için büyük proje
- `npm run dev -- start` API'yi kaynaktan çalıştırır, panonun son build'ini sunar. `cortexboard --version` sürümü yazar.
- Paket adı `cortexboard`, tek komut `cortexboard`. Pakette yalnızca `dist` (kaynak haritaları hariç), `CHANGELOG.md` ve `docs`. Test araçları (vitest, Playwright, axe, happy-dom, Testing Library) yalnız devDependency.
- **CI** (`.github/workflows/ci.yml`):
  - `test` matrisi, her push ve PR'da: tip kontrolü, `test:ci`, `test:web`, derleme ve `npm run smoke`. Lint, biçim ve `npm audit --audit-level=high` yalnız ubuntu/Node 24 ayağında. Audit `--omit=dev` olmadan çalışır: pano kütüphaneleri devDependency ama dist'e paketleniyor.
  - `e2e` işi (yalnız ubuntu/Node 24): build, Chromium kurulumu, `npm run e2e`. Hata olursa `playwright-report/` ve `test-results/` 7 gün artefakt olarak kalır.
  - `workflow_call` ile yayın iş akışından da çağrılır.
  - Depo: github.com/alibuyukkilinc/cortexboard. Provenance, package.json'daki `repository.url` ile derleyen depoyu karşılaştırır; depo adı değişirse package.json da değişmeli.
- **Yayın** (`.github/workflows/release.yml`): `v*.*.*` etiketi → tüm CI → etiket package.json sürümüyle aynı mı → `npm publish --provenance` (`NPM_TOKEN`) → GitHub sürümü; notları `scripts/release-notes.mjs` CHANGELOG'dan çıkarır. `prepublishOnly` typecheck, lint, test, test:web, build ve smoke'u yeniden çalıştırır.
- İş akışı günlüğünü okumak için GitHub oturumu gerekiyor. Bu yüzden hatalar `::error::` anotasyonu olarak da basılır; anotasyonlar koşu sayfasında ve checks API'sinde oturumsuz okunur.
- `npm run smoke` (`scripts/smoke.mjs`): paketi `npm pack` ile paketler (kaynak haritası sızarsa hata), boş klasöre kurar, `init` ve `start` çalıştırır, API/brief/pano cevabını kontrol eder, süreyi ölçer (sınır 120 sn, yerelde ~15-20 sn).
