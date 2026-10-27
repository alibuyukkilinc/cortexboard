---
title: "Kalite kapısı: arayüz testleri, erişilebilirlik ve performans ölçümü"
summary: "Arayüz: `npm run test:web` (Vitest, token ve AA kontrast). Tarayıcı:
  `npm run e2e` (Playwright, 375/1440 × açık/koyu; axe, odak, CLS < 0,05,
  telefonda taşma ve 44 px hedef). Piksel: `npm run e2e:visual` (Linux
  referansları, visual-baselines iş akışı). CI'da yalnız Ubuntu."
links:
  code:
    - file: vitest.config.ts
    - file: playwright.config.ts
    - file: playwright.visual.config.ts
    - file: e2e/server.ts
    - file: e2e/fixtures.ts
    - file: e2e/a11y.spec.ts
    - file: e2e/mobile.spec.ts
    - file: e2e/visual.spec.ts
    - file: e2e/layout-shift.spec.ts
    - file: e2e/board.spec.ts
    - file: e2e/perf.spec.ts
    - file: web/test/tokens.test.ts
    - file: web/test/overlays.test.tsx
    - file: scripts/seed-large.ts
    - file: scripts/perf-baseline.ts
    - file: .github/workflows/ci.yml
    - file: .github/workflows/visual-baselines.yml
    - file: tsconfig.test.json
verified_at_commit: 12d17270529dc142a060db242ca64bd6f576ec4e
id: 01M3FR50276C9Z7KZ55FD0SE18
status: active
updated_by: ai-agent
updated_at: 2026-09-28T04:29:42.510Z
---

Plan kararı `01M3FN2DTCVSN42RX5BWRRRYH7`, kuran görev UI-0 `01M3FN2P9XZD0NGJMX5EHDFGM7`. Her arayüz epiği ancak bu kapılar yeşilken biter.

## Katmanlar
- **Sunucu testleri:** `npm test` (node:test, `test/`).
- **Arayüz birim/bileşen:** `npm run test:web` → Vitest + Testing Library + happy-dom, dosyalar `web/test/**/*.test.ts(x)`, ayar `vitest.config.ts`. CI'da her OS'ta.
  - `tokens.test.ts`: ham renk yasağı ve WCAG AA kontrast (bkz. `frontend/design-system`).
  - `overlays.test.tsx`: Modal/Drawer odak tuzağı ve odak iadesi.
- **Tarayıcı:** `npm run build && npm run e2e` → Playwright (`playwright.config.ts`, `e2e/`). `e2e/server.ts` geçici, küçük, sabit bir proje kurar (her türden kayıt, bir taslak, aktivite) ve `dist/web`'i sunar; fixture sahibi imzalı giriş bağlantısıyla giriş yaptırır. Projeler: `wide-light`, `wide-dark` (1440), `phone-light`, `phone-dark` (375, dokunmatik). Ekran listesi `SCREENS` (`e2e/fixtures.ts`), axe ve telefon testi ortak kullanır; yeni ekran oraya eklenir.
  - `a11y.spec.ts`: her ekran + çekmece + yeni kayıt + taslak incelemesi axe WCAG 2.1 A/AA; serious/critical hata testi kırar, mesaj ölçülen oranı ve renkleri söyler.
  - `mobile.spec.ts` (UI-12): telefon projelerinde her ekran yana kaymaz (sayfa ve `main`) ve her kontrolün vuruş alanı en az 44 px. Vuruş alanı = kutu ya da mutlak `::after`; metin içindeki bağlantılar ve sözlük terimleri (WCAG 2.5.8 istisnası), etiket içindeki onay kutuları etiketle ölçülür. `.sr-only` ve `[data-scroll-x]` (bilerek kayan bölge) hariç.
  - `layout-shift.spec.ts`: Bildirimler, Pano, Onaylar, Aktivite, Bilgi yüklenirken CLS < 0,05; hata mesajı kayan öğeleri listeler.
  - `board.spec.ts`: kart sürükleme, kartın boş yerine tıklama, klavyeyle Enter. `period.spec.ts` (UI-11): hafta raporu, zaman çizelgesi, panoya geçiş.
  - `perf.spec.ts`: yalnız `PERF=1` ile; büyük projede ölçüm yazar.
  - Paralel sayfalar tek sunucuyu paylaşır; bir test başka projenin (wide/phone) yazdıklarını görebilir, bu yüzden testler kendi adlı verisini arar. `expect` bekleme süresi 15 sn.
- **Piksel regresyon (UI-12):** `npm run build && npm run e2e:visual` → `playwright.visual.config.ts`: kendi portunda (4798) kendi taze sunucusu (`E2E_TOKENS=tokens-visual.json`, iki sunucu birbirinin token dosyasını ezmesin), `e2e/visual.spec.ts`: Bildirimler, Pano, Bilgi, Onaylar, Aktivite × 4 proje, tam sayfa, `time` ve canlı göstergesi maskeli, fark eşiği %1. Referanslar `e2e/__screenshots__/<proje>/` altında ve **yalnız Linux'ta üretilir** (yazı tipleri OS'a göre farklı çizilir): GitHub'da elle çalıştırılan `Visual baselines` iş akışı (`.github/workflows/visual-baselines.yml`) `--update-snapshots=all` ile üretir ve `visual-baselines` artefaktı olarak yükler; indirilip commit'lenir. Referansı olmayan ekran atlanır (kırılmaz), commit'lendikten sonra CI'daki `e2e` işi karşılaştırır. Windows'ta üretilen referans commit'lenmez.
- **Tip ve lint:** `tsconfig.test.json` testleri, e2e ve betikleri de denetler; oxlint `web/test` ve `e2e`'yi de tarar.
- CI: ayrı `e2e` işi, yalnız Ubuntu/Node 24 (`npm run e2e`, sonra `npm run e2e:visual`); hata olursa rapor ve izler artefakt olarak kalır.

## Büyük veri ve ölçüm
- `npx tsx scripts/seed-large.ts <yeni klasör>` (varsayılan 5000 kayıt, 2000 düğüm, 50000 aktivite, 60 taslak; deterministik, gerçek servislerle yazar). Tam boy ~11 dk sürer.
- `npx tsx scripts/perf-baseline.ts <klasör>`: ekranların açılışta yaptığı okumaların p50/p95 ve boyutu.
- `PERF=1 E2E_PROJECT=<klasör> npx playwright test perf --project=wide-light --workers=1`: ilk boyama, verinin çizilmesi, DOM boyutu, bir yazmanın tetiklediği istekler.

## Başlangıç ölçümü (2026-09-26, Windows geliştirici makinesi, büyük veri)
| Okuma | p50 ms | p95 ms | KB |
|---|---|---|---|
| `/api/counts` (her ekran) | 80 | 398 | 0 |
| `/api/inbox?limit=100` | 21 | 25 | 29 |
| `/api/approvals` | 64 | 74 | 21 |
| `/api/stale` | 7 | 8 | 0 |
| `/api/items?type=task&limit=500` (pano) | 16 | 16 | 130 |
| `/api/tree?depth=5` (seçiciler) | **1074** | **1156** | **428** |
| `/api/activity?limit=200` | 7 | 139 | 54 |
| `/api/search?q=login` | 60 | 79 | 7 |
| `/api/report?since=7d` | **19410** | **19613** | 7 |

- Projeyi açma (Cortex + indeks kontrolü): **22,5 sn**.
- Tarayıcı: ilk boyama 316–456 ms her ekranda. Veri çizilmesi: Bildirimler 0,9 sn, Onaylar 1,0 sn, Aktivite 0,9 sn, **Pano 3,7 sn (12 574 DOM düğümü)**, Bilgi 3,4 sn.
- Tek yazma açık panoda **4 istek** tetikler: `/api/counts`, `/api/rules/task`, `/api/tree?depth=5` (428 KB), `/api/items?...limit=500`.
- Paket: JS 520 KB (gzip 153 KB), CSS 54 KB (gzip 13 KB).
- Sonra: rapor, açılış ve yazma yavaşlıkları commit 97f0c38 ile düzeldi; pano artık sütun başına sayfalı (`/api/board`, UI-10), seçiciler ağacı indirmiyor (`/api/branches`).

## Bütçe (her epik ölçer)
API p95 < 150 ms · ilk boyama < 1,5 sn · listelerde en fazla 100 DOM satırı · bir SSE olayı en fazla 2 istek · JS gzip, 153 KB'nin %15 üstünü geçmez · CLS < 0,05 · telefonda yana kayma yok, vuruş alanı ≥ 44 px.
