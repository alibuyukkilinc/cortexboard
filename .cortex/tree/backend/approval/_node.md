---
title: Taslaklar ve onay politikası
summary: "Tür başına politika: auto (direkt), review (taslak) ya da human_only.
  AI bilgi yazımları bu repoda ve hub'daki Güvenilir ajanlarda direkt geçer; AI
  emin değilse review: true ile taslağa gönderir. Taslak onayında düğüm, kodu
  değişmediyse HEAD'e sabitlenir. Ekler taslağa giremez."
links:
  code:
    - file: src/core/cortex.ts
    - file: src/store/drafts.ts
    - file: web/src/pages/Approvals.tsx
verified_at_commit: 44ead045b5054c61d18ee283b272634c1a26c7cc
id: 01M34QY9GN6ZWRZ7CKCPF5SVBN
status: active
updated_by: ai-agent
updated_at: 2026-09-29T04:31:58.922Z
---

## Politika
- Her tür için `cortex.config.yaml` → `approval`: `auto` (AI direkt yazar), `review` (AI yazımı taslak olur), `human_only` (AI yazamaz). Kararlar `auto`, çünkü kabul ve ret zaten yalnızca insana ait (şema `human_only_statuses`).
- **Karar `01M3MXD1644M8SBHHT2RHP8XDB` (2026-09-29):** 30 günde 214 AI taslağı onaylanmış, 0 reddedilmişti; onay adımı hiçbir şeyi elemiyordu. Bu yüzden:
  - Bu repoda `approval.node: auto`.
  - Hub'da yeni oluşturulan AI ajanları **Güvenilir** (`trusted` → `Actor.policy = { node: "auto" }`); var olan ajanı başka projeye eklemek hâlâ Katkıcı (`backend/hub`).
  - `init` varsayılanı değişmedi: yeni yerel projelerde `node: review`.
  - İnsan onayı kararlar, `rules/` ve @humans soruları için kalır.
- **`review: true`** (`cortex_update_node`, `PUT /node`, `NodeInput.review`): yazımları doğrudan geçen bir AI, emin olmadığı tek bir yazımı taslak olarak insana gönderir (`putNode` içinde `policy === "review" || review === true`).
- Aktör başına istisna: `Actor.policy`, yoksa projenin politikası.

## Taslak akışı (`Cortex.putNode`, `approve`, `reject`, `approveMany`, `rejectMany`)
- AI `review` altında düğüm yazınca üst dalın varlığı hemen denetlenir (`parent_missing`), sonra taslak kaydedilir; o anki düğümün özeti `base_rev` olarak saklanır.
- AI aynı düğüme yeniden taslak önerirse eski taslağının yerine geçer; incelemeci her düğüm için tek taslak görür.
- `approve`: taslaktan sonra düğüm değiştiyse reddeder (409 `conflict`), zorlanırsa yine de uygular.
- Onayda sabitleme (`pinOnApproval`): taslağın bağlı dosyaları öneri commit'i ile HEAD arasında değişmediyse düğüm HEAD'e sabitlenir. Değiştiyse eski commit korunur, sonuç `warning: "stale_after_approval"` ve `stale_changes` döner; pano "Kontrol ettim: HEAD'de doğrula" seçeneğini sunar. `verify_at_head=true` onaylayanın HEAD'e kefil olmasıdır. Bir taslağı yazdıktan sonra aynı dosyalara kod commit'lenirse, onaylansa bile eskimiş kalır: taslakları kod durulduktan sonra yazmak ya da HEAD'de doğrulamak gerekir. (Eskimenin gösterilip gösterilmediğini `staleness` ayarı belirler, `backend/staleness`.)
- Toplu onay/ret: önce üst düğümler onaylanır, böylece yeni bir dal ve altındakiler birlikte onaylanabilir. Biri hata verirse diğerleri devam eder; onaydan sonra hâlâ eskimiş olanlar `stale_after_approval` listesinde döner.
- Onay ve ret yalnızca insana ait ve denetim kaydı bırakır (`draft.approved` / `draft.rejected`); raporlar AI onay oranını buradan hesaplar.
- Taslaklar `.cortex/drafts/` (hub'da proje bilgi klasörü) altında dosyadır.

## Onayın geldiği yerler
- **Pano, Onaylar sayfası** (`web/src/pages/Approvals.tsx`): taslaklar, karar önerileri, soru ve görev kapanışları tek kuyrukta.
- **AI sohbeti:** MCP elicitation ile insan sohbette onaylar; cevap kaynağıyla kaydedilir ve panodan geri alınabilir. Ayrıntı: `backend/approval/chat`.
- **Aktarılan cevaplar kuyruğu:** istemci soramadığında AI kişinin sözünü aktarır; `chat.relayed: pending` ise Onaylar sayfasının "AI sohbetinden aktarılanlar" bölümünde onay ya da ret bekler (`GET /api/chat/relayed`, `POST .../confirm`, `DELETE`).

## Diğer
- Ekler taslak olamaz (bayt taşıyamaz): politikası AI için `review` olan bir türde AI ek yükleyemez/kaldıramaz (403), `auto`'da doğrudan yükler, insan her zaman yükler (`ItemService.attachGate`).
- Hub'da onay listesi: onaylama yetkisi olan kendi görebildiği tüm taslakları, olmayan yalnızca kendi önerdiklerini görür.
