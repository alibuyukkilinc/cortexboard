---
title: Arka uç
summary: Node 22.16+ ve TypeScript 7. Tek bir Cortex çekirdek sınıfı var; REST
  (Fastify), MCP (stdio ve HTTP) ve CLI onun üstünde ince katmanlar. Asıl veri
  dosyalar, SQLite yalnızca yeniden kurulabilen önbellek.
links:
  code:
    - file: src/core/cortex.ts
verified_at_commit: 2a7b14697ac1c6333ac1fac454eba0517827bf2d
id: 01M34Q1CBCMK0W5QXHSQAY5PHG
status: active
updated_by: ai-agent
updated_at: 2026-09-24T15:08:06.133Z
---

İki çalışma biçimi var: `cortexboard start` tek projeyi yalnızca localhost'ta sunar (`src/api/server.ts`, pano oturumları `src/api/sessions.ts`), `cortexboard hub start` çok projeyi ekip için sunar (`src/hub`). İkisi de aynı proje rotalarını kullanır (`src/api/routes.ts`).

Her iş `Cortex` sınıfından geçer (`src/core/cortex.ts`): okuma, düğüm yazma, taslak ve onay (onayda HEAD'e yeniden sabitleme), kurallar, arama, doğrulama.
Kalemler, aktivite ve eskime için ayrı servisler var (`ItemService`, `ActivityService`, `StalenessService`), çekirdeğe bağlılar. Kalem ekleri `ItemService.attach/detach` üzerinden geçer.

Her yazımdan sonra `cortex.events` üzerinde `change` olayı yayılır. Web pano bunu canlı akışla (SSE, proje başına en fazla 50) alır, anlamla arama indeksi de bu olayda güncellenir.
`cortex.watch()` dosyalar elle değişince, git pull sonrasında veya başka bir süreç yazınca (ör. API'nin yanında çalışan MCP) indeksi kayıt düzeyinde yeniler (`src/core/sync.ts`). Ayrıca git HEAD'i 5 saniyede bir kontrol eder.
Açılışta indeks hâlâ baştan kurulur (`reindex()` kurucuda); ayrıntı `backend/index-search`.
