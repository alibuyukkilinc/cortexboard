---
title: Aktivite günlüğü
summary: "Kim ne yaptı ve neden: eylem, özet, neden, dosyalar, commit, ilgili
  kayıtlar. Dosyalı kayıt, o dosyalara uygulanan kabul edilmiş kararlara karşı
  kontrol edilir (uydu/uymadı/ilgisiz). Denetim kayıtları da burada; dosyalar
  git'te union ile birleşir."
links:
  code:
    - file: src/core/activity.ts
    - file: src/store/activity.ts
    - file: src/core/ruleCheck.ts
verified_at_commit: b5f712d674814e33d03dbd0517a04b3bac963c71
id: 01M34QY9JNH4GZNC68N7H8SJ0M
status: active
updated_by: ai-agent
updated_at: 2026-09-28T22:26:17.276Z
---

- `ActivityService.log` kaydı `rules/activity.schema.yaml`'a göre denetler; `refs` gerçek bir kalem kimliği ya da düğüm yolu olmalı.
- Cevap, değiştirilen dosyaları anlatan bilgi düğümlerini listeler (`related_knowledge`). Dosya bildirilmişse önce HEAD'e bakılır (`staleness.refresh(false, true)`: kısıtlamayı atlar, yalnızca HEAD değiştiyse yeniden hesaplar), çünkü AI genelde commit'ten saniyeler sonra kaydeder. Eskiyen düğümler (projenin `staleness` seviyesine göre) `stale: { severity, files }` ile işaretlenir.

## Karar kontrolü (karar `01M3MXD9VVDQJSDEFX60PQTAWH`, `src/core/ruleCheck.ts`)
- **Hangi kararlar** (`RuleCheckService.applicable(files, visible)`): dosyalara kod bağlantısıyla bağlı kabul edilmiş kararlar + dosyaları bağlayan bilgi sayfasının kendisine, altına ya da üst dallarına dosyalanmış kabul edilmiş kararlar. Dalsız (kök) kararlar sorulmaz: her değişiklikte sorulurlardı. Hub'da üyenin görmediği kararlar sorulmaz.
- **Beyan:** `log` girdisinde `decisions: [{id, verdict: followed|broken|n/a, note}]`; `broken` için not zorunlu, bilinmeyen kimlik hata. Eksik cevap **reddedilmez** (reddedilen kayıt kaybolan kayıttır): kayda `rule_check: {applies, answers}` yazılır, cevapta `rule_check` (unanswered, broken, sayılar) ve `rule_check_hint` döner.
- **Sonradan cevap:** `answer(actor, activityId, answers)` → `rules.checked` sistem kaydı (`refs: [activityId]`, append-only). Yalnızca kaydı yazan AI ya da bir insan. Durum (`state`) kaydın cevapları + sonraki cevaplar, en yenisi geçerli.
- **Görünürlük:** AI'ın brief'inde son 14 günün cevapsızları (`attention.unanswered_rule_checks`). İnsanlar yalnızca istisnaları görür: `report()` → `broken` ve `unanswered`; raporda `rule_checks`, Markdown'da "Kararlara uyum", Raporlar sayfasında "İnsanları bekleyenler" altında iki grup. `GET /api/rule-checks?since=`.
- Uçlar ve araçlar: `GET /api/code` → `decisions_to_check`; `POST /api/activity/:id/rules` (`log_activity` yetkisi); MCP `cortex_log_activity` (`decisions`), `cortex_answer_rules`.

## Diğer
- Sistem kayıtları (`node.updated`, `draft.*`, `item.created/updated/replied/claimed/released/attached/detached`, `rules.updated`, `rules.checked`) `meta` ya da `rule_check` taşır: raporlar metni ayrıştırmak zorunda kalmaz; eski kayıtlar için metin ayrıştırma yedek olarak duruyor.
- Depolama `src/store/activity.ts`: `activity/<gün>/<aktör>.jsonl`, yalnızca ekleme. Aynı aktör iki makinede aynı gün yazarsa aynı dosyaya ekler; `.cortex/.gitattributes` bu dosyaları `merge=union` ile birleştirir (satırlar bağımsız, kimlik tekil, okuyanlar kimliğe göre sıralar). Birleştirmede bozulmuş tek satır atlanır, günlüğün geri kalanı okunur.
- Raporda manşet yalnızca kayıtlardır (`logged`); denetim kayıtları ayrı sayılır (`system`).
