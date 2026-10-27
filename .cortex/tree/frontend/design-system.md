---
title: "Tasarım sistemi: renkler, yazı tipi, bileşenler"
summary: "Apple sistem görünümüne yakın: tek vurgu mavisi, nötr griler, gerçek
  siyah koyu tema. Renk yalnızca tema değişkeni, her metin/zemin çifti WCAG AA
  (tokens.test.ts). Boşluk `--space-*` ve yardımcı sınıflar; satır içi stil
  yalnızca veriden gelen değerler için. Dokunmatikte 44 px hedef."
links:
  code:
    - file: web/src/styles.css
    - file: web/src/ui.tsx
    - file: web/src/charts.tsx
    - file: web/src/main.tsx
    - file: web/test/tokens.test.ts
verified_at_commit: 12d17270529dc142a060db242ca64bd6f576ec4e
id: 01M34QYA1Q9QSJH06S50NZT2N4
status: active
updated_by: ai-agent
updated_at: 2026-09-28T04:29:04.245Z
---

Karar `01M3AJ1SRRPTM51GFWVBVT78PS` (tartışma `01M3AHHGHTMCEMGPQZZ55FV60W`): görünümü değiştirmeden sistemi her ekranda aynı uygula. Arayüz planı: karar `01M3FN2DTCVSN42RX5BWRRRYH7`; kalite kapısı `frontend/quality`.

## Kurallar (yeni kodda uyulacak)
- **Renk yalnızca değişken.** `web/test/tokens.test.ts` şunları CI'da kırar: üç tema bloğu dışındaki ham renk (`#hex`, `rgb()`, `white`… — maske gradyanında bile; yalnız alfa sayılıyorsa `var(--text)` yaz), TSX içindeki ham renk, iki koyu blokta farklı token kümesi, AA altı (4,5:1) metin/zemin çifti. Yeni renk üç blokta da tanımlanır; yeni bir metin/zemin kullanımı `PAIRS` listesine eklenir.
- **Metin olarak vurgu `--accent-text`,** dolgu ve kenarlık `--accent`. `--accent` sayfa zemininde metin olarak AA'yı geçmez (bağlantılar `a { color: var(--accent-text) }`).
- **`--faint` renkli dolgularda kullanılmaz** (pano sütunu `--fill`, fark panellerinin `-soft` zeminleri): orada 4,5'in altına düşer; ikincil metin orada `--muted`.
- **Renkli zemin üstü metin:** düğme `--on-accent`; pano etiketi `--on-label` (koyu, parlak etiketlerde); **beyaz yazı + kırmızı zemin her yerde `--label-critical`** (kritik etiket, "gecikti" rozeti): koyu temanın parlak `--danger`'ı beyaz yazıyla 2,5:1'de kalıyordu. Avatar baş harfleri `--on-avatar`; bildirim `--toast-*`; fark `--diff-*`.
- **Yazı boyu:** yalnızca `--text-2xs` 11 · `--text-xs` 12 · `--text-sm` 12,5 · `--text-base` 13,5 (gövde) · `--text-md` 15 · `--text-lg` 17 · `--text-xl` 22 · `--text-2xl` 26. Dokunmatikte form alanları `--text-input-touch` 16 (iOS altında sayfayı yakınlaştırır).
- **Dokunmatik (UI-12):** `@media (pointer: coarse)` içinde `--control` ve `--control-sm` = `--control-touch` 44 px. Büyüyebilen kontroller büyür (menü bağlantıları, sekmeler ve bölümlü düğmeler, "Kart ekle", ağaç satırları, marka bağlantısı, yatay çubuk grafik satırları). Metin ya da çip satırında duran küçük kontroller görünüşünü korur, **görünmez vuruş alanı** alır: `position: relative` + mutlak `::after` 44 px (çip düğme/bağlantıları, ekmek kırıntıları, zaman çizelgesi çubukları). Kartın başlığı `::after` ile bütün kartı kaplar (`PressCard`). Satır onay kutusu `.row-check-hit` etiketinin içinde (`htmlFor`/`id`; girdiye `::after` konamaz). Fareyle düzen değişmez. `e2e/mobile.spec.ts` bunu her ekranda ölçer.
- **Boşluk:** `--space-1..6` = 4 / 8 / 12 / 16 / 24 / 32 px. Tek seferlik değerler ölçeğe yuvarlanır (6→8, 10→12).
- **Kırılma noktaları:** yalnızca 600 / 860 / 1100 px.
- **Satır içi stil yok (UI-12):** yalnızca veriden hesaplanan değerler satır içidir (yüzde genişlik, konum, seri rengi, ölçülen yükseklik). Durumlar sınıftır (`.column.dimmed`, `.twisty-icon.open`, `.stale-icon.quiet`, `.is-loading`). Yardımcılar dosyanın sonunda, anlamlı sınıfları ezsin diye: `.gap-1/2`, `.mt-0..4`, `.mb-1..4`, `.mr-1/2`, `.mr-auto`, `.m-0`, `.p-3`, `.text-2xs/xs/sm`, `.italic`, `.minw-0`, `.nowrap`, `.items-start`, `.justify-end`, `.grow`, `.w-auto`, `.plain-link`, `.pre-wrap`, `.clickable`, `.measure`, `.fine-print`, `.select-wide`. Grafik açıklama kutuları `.key-ai/.key-human/.key-system`.
- **Cam etkisi** yalnızca üst çubuk, kenar çubuğu, pencere ve bildirimlerde. **Gradyan yok.**
- **Yatay kayan tablo:** `.table-scroll` + `role="region"`, `aria-label`, `tabIndex={0}` (axe `scrollable-region-focusable`); ekran okuyucu tablosu `<div className="sr-only">` içinde (`.sr-only` doğrudan `<table>`'a verilince kırpmaz, sayfayı taşırır).

## Yazı tipi
- Sıra: `-apple-system` / SF Pro, Inter Variable, sonra `"Inter Fallback"`: yerel Arial/Helvetica/Liberation Sans, Inter'in ölçülerine ayarlı (`size-adjust` vb.). Inter geç yüklenince satırlar aynı yerden kırılır; yoksa özet satırı yeniden kırılıp sayfayı kaydırıyordu (CLS 0,25).
- Inter ve JetBrains Mono `@fontsource-variable/*` ile `web/src/main.tsx` içinde; dış font servisi yok.
- Genel `h3` küçük, büyük harfli, soluk bölüm etiketidir.

## Değişkenler (`web/src/styles.css`)
- Temalar: `:root` (açık), `@media (prefers-color-scheme: dark)` ve `:root[data-theme="dark"]`. Ölçekler yalnızca `:root`'ta.
- Yüzeyler `--bg`, `--surface`, `--surface-2/3`, `--raised`; çizgiler `--border(-strong)`; metin `--text`, `--muted`, `--faint`.
- Vurgu `--accent`, `--accent-hover/soft/text`, `--on-accent`, `--ring`. Durum `--ok`, `--warn`, `--danger` (+ `-soft`). Gölgeler `--shadow-sm/--shadow/--shadow-lg/--shadow-control`.
- Tartışma seçenekleri `--opt-0..5`. Grafikler `--viz-*`.

## Bileşenler (`web/src/ui.tsx`)
- `Modal`, `Drawer`: `useFocusTrap` ile açılınca odak içeri girer, Tab son kontrolden ilke döner, kapanınca odak açan kontrole geri gelir. Escape yalnızca en üstteki pencereyi kapatır.
- `Pressable`/`ListRow`: içinde başka kontrol olmayan tıklanır satır/kart (`role="button"`, Enter/Space).
- `PressCard` + `PressTitle`: içinde kendi kontrolü olan kart/satır (onay kutusu, "Şuraya taşı" menüsü). `role="button"` içinde kontrol olamaz (axe `nested-interactive`); burada başlık gerçek `<button>`, `::after` ile bütün kartı kaplar, iç kontroller (etiketler dahil) üstte (`z-index: 1`).
- `Markdown`: görev listesi kutuları salt okunur ve etiketli ("Tamamlandı/Yapılmadı").
- `Loading({ rows })` iskelet; `EmptyState` her boş durumda (UI-12'de hub, Bilgi ve Raporlar'daki eski `.empty` de ona geçti). Ekran, bölümleri farklı isteklerden geliyorsa hepsi gelene kadar iskelet gösterir (ör. Bildirimler), yoksa geç gelen bölüm diğerlerini iter.
- `useAsk`: onay ve metin soran pencere; `input.line` ad gibi tek satırlık alan.
- Etiketler `StatusChip`, `TypeChip`; çizgi ikonlar `Icon`; emoji yok. `select`'lerin görünür etiketi yoksa `aria-label`.

## Grafikler (`web/src/charts.tsx`)
- `StackedColumns`, `HBars`, `Timeline` (UI-11). Odaklanabilir SVG grupları `role="img"` + `aria-label`; HTML işaretleri odaklanır bir öğe olmalı (`Timeline` çubuğu bir bağlantı). Her grafikte üzerine gelme ve odak ipucu; tek seri dışında açıklama; tablo görünümü ya da ekran okuyucu tablosu.
