---
title: Bağlı projeler
summary: "Bir projenin AI'ı bağlı projenin (ör. mobil → backend) bilgisini tek
  MCP üzerinden salt okur: search, tree, node, items ?project=<id>."
links:
  code:
    - file: src/hub/server.ts
verified_at_commit: e62c847ba735c3eb43b9abc680fc13cf8c76646e
id: 01M3PN87YF8D6VVJ79EXE0BNSN
status: active
updated_by: claude-code-new
updated_at: 2026-09-29T13:21:48.495Z
---

## Bağlı projeler (karar `01M3AM8C6VZ0WB1MA2SMANEQJH`, commit 8c9308d)
- Proje `cortex.config.yaml` → `linked: [backend]` (birden çok olabilir). Okuma istekleri `?project=<id>` ile bağlı projeye yönlenir (MCP'de araçların `project` parametresi).
- Panelden: `PUT /api/admin/projects/:id/links` `{ linked, grant_readers }` (yalnız organizasyon yöneticisi). `saveLinked` (`src/core/project.ts`) dosyadaki yorumları koruyarak yazar ve çalışan projeye hemen uygular; bilinmeyen proje ve kendine bağlama 400. `grant_readers: true` projenin AI üyelerini bağlanan projelerde üye değillerse `reader` yapar. `/api/admin/projects` her projenin `linked` listesini döndürür (`readLinked`, projeyi açmadan config'den). (Görev 01M3NP26PP826NEJVT49DS0BT6.)
- Hub `preHandler`'ı (`src/hub/server.ts`): kaynak projede üyelik denetlenir; hedef `linked` içinde mi, hedefte üyelik var mı bakılır; sonra `req.cortex` hedef proje, `req.access` hedefteki üyelikten ve **salt okumaya kısılmış** (`readOnly`), `req.crossProject` = hedef. Cevaplar `project` alanı taşır.
- Yalnızca `GET` ve `CROSS_READS` (`/search`, `/tree`, `/node`, `/items`); diğerleri `cross_project_read_only`. Bağlı değilse `not_linked` (ipucunda bağlı liste), üye değilse 403.
- Brief `linked: [{ id, name, summary, readable }]`; okunamayan projenin özeti boş.
- Tek proje modunda `projectRoutes` `?project=`'i reddeder (sessizce kendi projesinden cevaplamasın).
- Projeler arası soru yok (reader rolünde `ask` yok); ayrı bir iş.
