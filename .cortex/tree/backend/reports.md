---
title: Raporlar
summary: "Dönem raporu (hafta, 7/30/90 gün, tarih aralığı): gerekçeli kayıtlar,
  denetim izi, açılan/kapanan kayıtlar, sorular, kararlar, onay oranı, issue
  yaşı, eskimiş bilgi, epikler ve milestone'lar. Aktör türü kayıttaki
  `actor_kind`'den; bilinmeyen aktör insan sayılmaz. İndeksten sayılır, LLM
  yok."
links:
  code:
    - file: src/core/reports.ts
    - file: src/core/reportMarkdown.ts
    - file: web/src/pages/Reports.tsx
    - file: web/src/charts.tsx
    - file: src/util/time.ts
    - file: src/core/activity.ts
verified_at_commit: "5269221"
id: 01M34QY9PF26EEEGQRYECABXXH
status: active
updated_by: claude-code-new
updated_at: 2026-09-29T10:31:13.263Z
---

- `parsePeriod`: göreli dönemler projenin saat diliminde takvim gününe hizalı ("7d" = bugün + önceki 6 gün). Saat dilimi `cortex.config.yaml` → `timezone`, yoksa UTC. Gün hesabı `src/util/time.ts` içinde, yalnızca Intl ile; yaz saati geçişleri doğru. En fazla 366 gün. Yalın tarih (`2026-09-21`) projenin diliminde o günün başı.
- `ReportService.build` dönemin aktivitesini (`activityBetween`), kalemleri (`index.reportItems()`), düğümleri (`index.nodeSummaries()`), taslakları ve eskime durumunu okur. **Kalem, yanıt ya da düğüm dosyası okumaz:** soru cevap süresi (`answered_at/by`), kapanan issue'nun `resolution`'ı, `severity`, `due`, `milestone`, kutu sayıları (`checklist_done/total`) ve `updated_at` indeks sütunlarında (`backend/index-search`). Eskiden her kalemi ve yanıtı diskten okuyordu; 1.500 kalemde 6 sn sürüyordu, şimdi ~0,12 sn.
- **Aktörün türü** (commit 5269221): her etkinlik kaydı yazılırken aktörün türünü taşır (`Activity.actor_kind`: `log` ve kural cevabı aktörden, `system` yapılandırmadan; yapılandırmada yoksa yazılmaz). Rapor sırayla şuna bakar: kaydın `actor_kind`'i → aynı dönemde o aktörün başka bir kaydındaki tür → yapılandırma → `unknown`. Eskiden yapılandırmada olmayan herkes insan sayılıyordu (chatgpt, antigravity insan görünüyordu). `unknown` hem insan hem AI sayısının dışında kalır: `totals.activity.logged.unknown`, `daily[].unknown`, aktör satırında `kind: "unknown"`. Pano grafiği ve markdown bilinmeyeni yalnız varsa gösterir (`--viz-unknown`, "Bilinmeyen"). Not: yerel projede hub üyelerinin eski kayıtları da bilinmeyen görünür; yeni kayıtlar türünü taşıdığı için bu zamanla kaybolur.
- Günlük seri: gün başlangıçları bir kez hesaplanır, her kayıt gününü ikili aramayla bulur (her kayıt için Intl çağırmak raporun geri kalanından pahalıydı). `terminal` bayrağı (tür, durum) çifti başına bir kez sorulur.
- Aktivite iki ayrı sayı: `totals.activity.logged` (birinin kendi yazdığı "ne yaptım, neden" kaydı) ve `totals.activity.system` (Cortex'in denetim kaydı). Manşet `logged`'dır. `daily[].ai/human/unknown` yalnızca kayıtları, `daily[].system` denetimi sayar.
- **Epikler (UI-11):** gövdesinde `- [ ]` kutusu olan arşivsiz kayıt bir epiktir (plan kararı 01M3FN2DTCVSN42RX5BWRRRYH7). `epics[]`: açık olanlar ve dönemde hakkında kayıt düşülenler; `{ id, type, title, status, open, done, total, milestone, assignee, updated_at, activity }`, önce açıklar, sonra dönemdeki kayıt sayısı, sonra son değişiklik. İlk 30'u döner, `epics_total` hepsinin sayısı.
- **Milestone'lar (UI-11):** görev ve issue'ların isteğe bağlı `fields.milestone` alanı (şema: `MILESTONE_TYPES`, en çok 60 karakter). `milestones[]`: ada göre gruplar, `{ name, total, done, open, epics, closed_in_period, start, target, last_activity, overdue }`. `start` ilk kaydın açıldığı gün, `target` kayıtlarının en geç `due`'su (yoksa null), `overdue` hedef bugünden önce ve açık iş varken. Bitmiş ve dönemde hareketsiz milestone listeden düşer. Sıra: hedefe göre, hedefsizler sonda. `today` projenin diliminde bugün.
- Bilgi sağlığı: `knowledge.stale` yalnızca eyleme değer eskimiş düğümler (yüksek + orta, ertelenmemiş), `knowledge.stale_info` geri kalanı; `attention.stale_nodes` her düğümün derecesini taşır.
- **Raporlar sayfası** (`web/src/pages/Reports.tsx`): varsayılan **Bu hafta** (pazartesi başlar, okuyanın takviminde), ‹ › ile hafta gezilir; 7/30/90 gün de seçilir. Dönem URL'de (`#/reports?week=2026-09-14`, `?since=30d`). KPI'ların altında milestone zaman çizelgesi (`Timeline`, `web/src/charts.tsx`), sonra epik listesi.
- Panoda denetim serisi bir bağlam serisidir (`Series.context`, `web/src/charts.tsx`): açıklamada ve ipucunda görünür, çizilmez ve ekseni belirlemez.
- Kısmi görünürlüğü olan hub üyesi proje çapındaki raporu alamaz (403).
- `reportToMarkdown(report, lang)`: Slack'e veya PR açıklamasına yapıştırmak için; milestone tablosu ve epik listesi de içinde.
- Erişim: `GET /api/report` (`format=md`), MCP `cortex_report` (yalnız `--tools full`), CLI `cortexboard report`, panoda Raporlar sayfası.
- "Belgelenmemiş dal" = özetinde hâlâ init'in yer tutucu metni olan dal (`isPlaceholder`, `src/core/init.ts`).
