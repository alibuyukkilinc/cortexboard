---
title: "Arşiv: artık geçerli olmayan bilgi"
summary: "Artık geçerli olmayan kayıt ve bilgi arşivlenir: arama, brief, ağaç,
  kod bağlamı, listeler ve eskimeden çıkar, dosyada ve git'te kalır. AI önerir
  (taslak), insan onaylar; geri getirme ve kalıcı silme insanda. Mantık
  src/core/archive.ts."
links:
  code:
    - file: src/core/archive.ts
    - file: src/core/cortex.ts
    - file: src/index/db.ts
    - file: src/api/routes.ts
    - file: src/mcp/server.ts
    - file: web/src/pages/Archive.tsx
verified_at_commit: f33a9ff7bc6fe6664f6a34b1dcf2400957026d2e
id: 01M3ANSGK2BYD1WYG52WHSKNN2
status: active
updated_by: ai-agent
updated_at: 2026-09-25T19:27:44.968Z
---

## Neden
Bir kez yaşanıp kalıcı olarak çözülmüş bir sunucu sorunu, yerine yenisi gelen bir karar ya da kaldırılmış bir kod için bilgi dalı her aramada güncel bilginin yanında çıkıyor ve token harcıyordu. Kullanıcının seçimleri (2026-09-25): varsayılan arşiv, istenirse kalıcı silme; AI önerir, insan onaylar; eski aktivite yalnızca aramadan çıkar.

## Nasıl çalışır
- Durum dosyada: kayıt ve düğümün üst bilgisinde `archived: { at, by, reason }`. Yeniden indeksleme ve git pull durumu taşır. İndeks `INDEX_VERSION` 8: `items.archived`, `nodes.archived`.
- Arşivlenen kayıt şunlardan çıkar:
  - varsayılan arama (`Cortex.search` sonuçları süzer; `archived: true` hepsini getirir),
  - `queryItems` (varsayılan `archived: "exclude"`: listeler, gelen kutusu, brief sayıları, kod bağlamı),
  - ağaç (`children`, `childCount`),
  - eskime ve kod bağlamı (arşivlenen kaydın kod bağlantıları indekse yazılmaz).
- Kimliği ya da yoluyla okunabilir kalır (`cortex_item`, `cortex_node`).
- Arşivlenmiş bir düğümü düzenlemek onu geri getirmez (`putNode` `archived`'ı korur).

## Kurallar
- Yalnızca bitmiş kayıt (`terminal`): açık iş ve kabul edilmiş karar arşivlenemez (`not_finished`; kararı önce yenisiyle geçersiz kıl).
- Düğüm: kök olamaz, aktif alt düğümü ve altında açık kaydı olmamalı.
- İnsan hemen arşivler. AI `cortex_archive` (`action: "propose"`) ile en az 10 karakterlik gerekçe verir; her kayıt için bir taslak açılır ("Archive: …"), Onaylar sayfasında onaylanır. Taslak normal `approve` akışıyla uygulanır (`base_rev`: `itemRevision` / `nodeRevision`).
- Geri getirme (`/archive/restore`) ve kalıcı silme (`/archive/purge`): insan + `approve`. Yalnızca arşivlenmiş olan silinir; git geçmişinde kalır.

## Öneriler (`/archive/candidates`, `cortex_archive` `candidates`)
- `archive.after_days` (varsayılan 30) gündür dokunulmamış, bitmiş ve hiçbir açık kaydın `links.items`'ında geçmeyen kayıtlar,
- `deprecated` durumundaki düğümler.
Öneri listesidir; kimse arşivlemeden hiçbir şey değişmez.

## Aktivite
`archive.activity_days` (varsayılan 90) günden eski aktivite varsayılan aramadan çıkar. Günlük dosyaları, aktivite akışı ve raporlar değişmez: denetim izi silinmez.

## Arayüz ve araçlar
- Pano: Hafıza → **Arşiv** (`web/src/pages/Archive.tsx`): Öneriler (seç, gerekçe yaz, arşivle), Arşivdekiler (geri getir, kalıcı sil).
- MCP: `cortex_archive` (24. araç), `cortex_search` `archived` parametresi.
- REST: `GET /archive/candidates`, `GET /archive`, `POST /archive`, `/archive/restore`, `/archive/purge`.
- Testler: `test/archive.test.ts`.
