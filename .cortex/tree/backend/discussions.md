---
title: Tartışmalar (discussion)
summary: "`discussion` kayıt türü: insanlar ve AI'lar bir soruya seçenek
  destekleyen, kanıtlı görüş yazar. Kör ilk tur, son tutum = oy, sayım çoğunluğu
  önerilen karara çevirir, kararı insan kabul eder. Mantık
  src/core/discussions.ts'te."
links:
  code:
    - file: src/core/discussions.ts
    - file: src/core/schema.ts
    - file: src/core/items.ts
    - file: src/api/routes.ts
    - file: src/mcp/server.ts
    - file: web/src/pages/Discussions.tsx
verified_at_commit: 4a005676941ea541e4c54fb5a19eb7183a44bee7
id: 01M3AFWW60RCKHTQVV4NDAHZQ7
status: active
updated_by: ai-agent
updated_at: 2026-09-24T21:20:24.730Z
---

## Ne
Tartışma, `discussion` türünde bir kayıttır; her görüş bir yanıttır (`replies/*.md`). Ayrı depolama yok, git'te diğer kayıtlar gibi durur. Web'de panodan ayrı ekranı var (`#/discussions`, `web/src/pages/Discussions.tsx`); pano ve yeni kayıt diyaloğu bu türü göstermez. İlk sürüm 0.3.0.

## Aşamalar (status)
- `open`: görüş toplanıyor. `blind` (varsayılan true) ise kör tur: okuyucu, kendi `opinion`'ını yazana kadar diğerlerinin görüşlerini `sealed: true` ve boş gövdeyle alır. Tartışmayı açan kişi ve katılımcı listesi dışındaki insanlar her şeyi görür.
- `deliberating`: görüşler açık; `rebuttal` ve `synthesis` yazılabilir. Yeni bir `stance` oyu değiştirir.
- `voted`: `POST /discussions/:id/close-vote` oyları saydı. Net çoğunluk varsa `proposed` bir decision oluşur (`links.items` = tartışma, `fields.outcome` = decision, gövdenin ilk satırı = seçenek). Beraberlikte decision oluşmaz.
- `decided`: decision `accepted` olunca `ItemService.update` → `DiscussionService.onDecisionAccepted` tartışmayı kapatır.
- `POST /discussions/:id/decide {option}` (yalnızca insan, `approve` izni):
  - Seçilen seçenek bekleyen önerinin seçeneğiyle aynıysa o öneri kabul edilir; yeni karar açılmaz. (4a00567'den önce öneri reddedilip aynı içerikte ikinci bir karar açılıyordu; ilk gerçek tartışmada `01M3AJ1J7JGZKC5E60BJDA9MA3` böyle reddedilmiş kaldı.)
  - Farklıysa bekleyen öneri reddedilir, seçilen seçenekle yeni karar açılıp kabul edilir.
- `voted` ve `decided` düz bir durum değişikliğiyle verilemez; yalnızca servis `internal` bayrağıyla yazar.

## Kurallar
- Yanıt alanları: `kind` (opinion | rebuttal | comment | synthesis, zorunlu), `stance` (seçeneklerden biri, birebir), `confidence`, `evidence`. `opinion` için stance + confidence + evidence zorunlu.
- `participants` doluysa yalnızca onlar (ve açan kişi) oy verir; herkes yorum yazabilir. Boşsa herkes katılır.
- Yanıt izni hub'da `ask` (sorulardaki gibi); açmak `write_items`.
- Kör turda yanıt metinleri arama indeksine (`src/index/db.ts`, `isSealed`) ve liste önizlemesine girmez.
- Gelen kutusu nedeni `discussion_needs_your_view`; `/counts` içinde `discussions` rozeti.

## MCP
`cortex_discussions`, `cortex_discuss` (görüş yaz), `cortex_close_vote`. Tartışma açmak: `cortex_create_item` type `discussion`. Araçlar oturum başında yüklenir: yeni sürüme geçen bir ajan oturumu yeniden başlatmadan bunları görmez.

## İlk gerçek kullanım (2026-09-24)
"Tasarım daha üst düzeye çıkabilir mi?" (`01M3AHHGHTMCEMGPQZZ55FV60W`): ai-agent ve chatgpt "Evet gidelim" dedi, glassmorfizmi ikisi de reddetti; karar `01M3AJ1SRRPTM51GFWVBVT78PS`, uygulaması `frontend/design-system`.
