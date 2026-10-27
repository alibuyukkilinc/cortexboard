---
title: REST API
summary: Proje rotaları src/api/routes.ts'de; tek projede /api, hub'da
  /api/p/:project altında. Hub'da her rota rol yetkisini ve görünürlüğü
  denetler; liste görünürlüğü SQL'de. Pano sütun başına sayfalı (/board),
  aktivite imleçle; kayıtlı görünümler /views.
links:
  code:
    - file: src/api/routes.ts
    - file: src/api/server.ts
    - file: src/api/access.ts
    - file: src/hub/access.ts
    - file: src/core/views.ts
verified_at_commit: 009e91d2d4e68bcb380355181099061cc1d92843
id: 01M34QY9R9NE0TTWX5ZP3R74J1
status: active
updated_by: ai-agent
updated_at: 2026-09-28T04:01:09.205Z
---

- Rotalar `projectRoutes` içinde (`src/api/routes.ts`); `req.cortex` projeyi, `req.access` (yalnızca hub) rolü taşır. `need(req, perm)` yetkisi olmayanı 403 ile durdurur; gizli kayıtlar 404 döner. Tek proje sunucusu `buildServer`, ortak parçalar `baseServer` (`src/api/server.ts`, hub için `trustProxy` seçeneğiyle). Tek projede kimlik: Bearer token veya pano oturumu, yalnızca localhost.
- Görünürlük: `Access.seesItem` (bellekte) ve `Access.itemSql()` (aynı kural, SQL parçası). `/items`, `/board`, `/inbox` ve brief'in gelen kutusu SQL parçasını `queryItems`'a geçirir; süzme LIMIT/OFFSET'ten ÖNCE olur. Arama, taslaklar, aktivite ve kod bağlamı hâlâ sonradan süzülür.
- **Filtreler ve sayfalama (UI-10):**
  - `GET /api/items` ve `GET /api/board`: `since` / `until` (`updated_at`, `[since, until)`), mevcut `type/status/assignee/author/path/open/cursor` ile.
  - `GET /api/board?type=&path=&assignee=&author=&since=&until=&per_status=` → `{ type, columns: [{ status, total, items, next_cursor }] }`: türün her durumu için bir sayfa (varsayılan 20, en çok 100) ve toplam. Sütun devamı `GET /items?type=&status=&cursor=`. `type` yoksa 400. Pano artık tüm türü tek istekte indirmez (500 üstü sessizce kayboluyordu).
  - `GET /api/search`: `actor` (kayıtta yazan, düğümde son düzenleyen, aktivitede aktör), `assignee` (yalnız kayıtlar), `since` / `until`. Bu süzgeçler sıralamadan sonra uygulandığı için havuz 10 kat derin çekilir.
  - `GET /api/activity`: `until` ve `before` (bir kayıt kimliği; ondan eskiler). Yanıt `next_cursor` taşır (sayfa doluysa son kaydın kimliği). Hub'da üye süzgeci sonradan uygulanır; imleç süzülmemiş sayfadan gelir, bu yüzden üyenin sayfası kısa olabilir ama bir sonraki sayfa kaldığı yerden başlar.
  - `GET /api/branches?q=&limit=` → `{ branches: [{ path, title }] }`: yolu ya da başlığı metni içeren arşivsiz dallar, görünürlüğe göre süzülür (seçiciler ağacı indirmesin diye).
  - MCP'de aynı süzgeçler: `cortex_search` (`actor`, `assignee`, `since`, `until`), `cortex_items` (`since`, `until`), `cortex_activity` (`until`, `before`).
- **Kayıtlı görünümler** (`src/core/views.ts`): `GET /api/views`, `PUT /api/views` `{ name, page: board|search|activity, query }` (aynı sayfada aynı ad = üzerine yazar; en çok 50), `DELETE /api/views/:id`. Kişiye özel, `.cortex/views/<aktör>.json`; başkası görmez, indekslenmez, git dışı (`.gitignore`'a `views/`; eski projelere `loadProject` ekler). Hub'da proje dizininde üye başına dosya.
- `GET /api/counts` → `{ inbox, approvals, stale, discussions }`: panonun kenar çubuğundaki rozetler (`discussions` = senden görüş bekleyen açık tartışmalar). Aynı görünürlük kuralları uygulanır (taslak süzgeci `/approvals` ile ortak `visibleDrafts` yardımcısından gelir; eskime sayısı yalnızca eyleme değer olanlar). Rozetler her canlı olayda yenilendiği için ucuz olması şart: 14 taslakla eski üç istek 5.856 bayttı, bu uç 75 bayt. Listeleri gösteren sayfalar kendi tam isteklerini yapmaya devam eder.
- `GET /api/items/:id` okuyanı (`viewer: req.actor`) çekirdeğe geçirir: kör turdaki bir tartışmada başkalarının görüşleri `sealed` gelir ve cevap bir `discussion` özeti taşır.
- Yanıt yazmak (`POST /items/:id/replies`) soru ve tartışmada `ask`, diğer türlerde `write_items` ister; hub'da izleyiciler de tartışmaya katılabilir.
- Tartışmalar (`backend/discussions`): `GET /api/discussions?open=` (oy sayımı, kim yazdı, kim bekleniyor), `POST /api/discussions/:id/close-vote` (`write_items`; çoğunluk önerilen karar olur), `POST /api/discussions/:id/decide` `{ option }` (`approve`, yalnızca insan).
- `GET /api/events` panonun canlı güncelleme akışı (SSE). Proje başına en fazla 50 akış (`CORTEX_SSE_LIMIT`), fazlası 503 + `Retry-After: 30`.
- Toplu onay: `POST /api/approvals/approve` `{ ids, force?, verify_at_head? }`, toplu ret: `POST /api/approvals/reject` `{ ids, reason? }`.
- Eskime: `GET /api/stale` (`actionable` sayısı + düğümler, derece ve başlıkla), `POST /api/verify/{yol}`, `POST /api/verify` `{ paths }`, `POST|DELETE /api/snooze/{yol}` (yalnızca insan).
- Ekler: `GET /api/items/:id/files` (liste), `POST /api/items/:id/files?name=<ad>` (gövde dosyanın kendisi, her içerik türü; bu kapsamda JSON ayrıştırıcı dahil tüm ayrıştırıcılar kaldırılıp tek bir bayt ayrıştırıcı konur, gövde sınırı 15 MB), `GET /api/items/:id/files/:ad` (`?download` indirmeye zorlar), `DELETE /api/items/:id/files/:ad`. Yazma `write_items` ister; `GET /items/:id` cevabı `attachments` taşır.
- Düğüm silme: `DELETE /api/node/{yol}?reason=`, yalnızca insan; alt düğümü ya da açık kaydı olan düğüm silinmez (409).
- Derlenmiş panoyu `dist/web` altından sunar (`wildcard: true`); uzantısız yollar panonun sayfasına düşer, bulunamayan dosya 404.
- Hata çevirici ortak (`setErrorHandler`); biçim: `{ error: { code, message, hint }, _meta }`.
