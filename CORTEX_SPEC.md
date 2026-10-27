# Cortex — İnsan + AI Ortak Proje Beyni

> Bu dosya Cortex'in **ana spesifikasyonudur** ve kodla uyumlu tutulur. Bir AI'a veya geliştiriciye verildiğinde sistemi sıfırdan kurabilecek kadar net olmalıdır.
> Ayrıntılı ve güncel proje bilgisi (hangi dosya ne yapar, neden böyle karar verdik) Cortex'in kendi bilgi ağacındadır: `.cortex/`.
> Durum: v1 tamam (6 dilim) · Paket: `cortexboard` · Lisans: MIT · Dil: kod/API İngilizce; arayüz ve README İngilizce + Türkçe; projeye yazılan içerik projenin seçtiği dilde

---

## 1. Neden var?

Bugün AI ile yazılım geliştirirken:
- Proje bilgisi dağınık `.md` dosyalarında yaşıyor. Bu dosyalar eskiyor, birbiriyle çelişiyor, AI'ın kafasını karıştırıyor.
- AI her oturumda projeyi baştan anlamaya çalışıyor, tüm dokümanları okuyup token harcıyor.
- İnsan, AI'ın ne yaptığını ve neden yaptığını takip edemiyor. "Nasılsa AI halleder" algısı proje hakimiyetini insandan alıyor.

**Cortex** projenin tek doğruluk kaynağıdır. Bilgi ağacını, iş panosunu, kararları, soruları ve AI aktivitesini tek yerde tutar. İnsanlar, AI'lar ve diğer AI'lar süreci buradan yürütür. **Kontrol insanda kalır.**

## 2. Temel ilkeler (pazarlık dışı)

1. **Token dostu:** AI hiçbir zaman "her şeyi" çekmez. Önce özet alır, sonra ihtiyaç duyduğu dala iner (kademeli yükleme). Sistemin kendisi hiçbir LLM çağrısı yapmaz.
2. **Tek komutla ayağa kalkar:** `npx cortexboard init` ve `npx cortexboard start` yeterlidir. Harici veritabanı, Docker veya API anahtarı gerekmez.
3. **Git dostu:** Veri projenin içindeki `.cortex/` klasöründe, okunabilir dosyalar olarak durur. Git ile versiyonlanır, diff alınır, merge edilir.
4. **Kontrol insanda:** Kuralları, şemaları, yazım dilini ve onay politikalarını insan belirler. AI'ın kritik değişiklikleri onaya düşer.
5. **Şeffaflık:** AI'ın her anlamlı eylemi (ne, neden, hangi dosya, hangi commit) kaydedilir ve insan tarafından sorgulanabilir.
6. **Kendini anlatan API:** AI bir ucu kullanırken o ucun kurallarını da öğrenir. Ayrı dokümana ihtiyaç yoktur.
7. **Basitlik:** Yeni bir geliştirici veya AI, 5 dakikada kullanmaya başlayabilmelidir.

## 3. Teknoloji

| Katman | Seçim | Not |
|---|---|---|
| Çalışma ortamı | Node.js ≥ 22.16 (TypeScript; yerleşik SQLite FTS5 ile ilk bu sürümde geliyor) | `npx cortexboard` ile dağıtım |
| HTTP API | Fastify | Yalnızca 127.0.0.1 |
| MCP | `@modelcontextprotocol/sdk` | stdio |
| İndeks | Node'un yerleşik `node:sqlite` modülü + FTS5 | **Yeniden üretilebilir önbellektir**, git'e girmez. Yerel derleme gerektiren paket yok |
| Anlamla arama | `@huggingface/transformers` + `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (q8) | İsteğe bağlı: `cortexboard semantic on` bilgisayar başına bir kez `~/.cortex` altına kurar. Vektörler SQLite'ta saklanır, arama bellekte çarpım taramasıdır |
| Web pano | React + Vite | Derlenmiş hâli pakete gömülü gelir |
| Dosya formatı | Markdown + YAML frontmatter, aktivite için JSONL | İnsan okuyabilir, diff alınabilir |
| Kimlik | ULID | Paralel yazımda çakışma olmaz |

## 4. Depolama düzeni

```
proje/
└── .cortex/
    ├── cortex.config.yaml       # proje adı, aktörler, onay politikası, rapor saat dilimi (commit'lenir)
    ├── .secrets.yaml            # aktör token'ları (git'e girmez)
    ├── rules/                   # insan kontrolündeki kurallar ve şemalar
    │   ├── _global.yaml         # tüm AI'lara geçerli kurallar + yazım dili (language: tr)
    │   ├── node.schema.yaml  activity.schema.yaml
    │   ├── task.schema.yaml  issue.schema.yaml  question.schema.yaml  note.schema.yaml  decision.schema.yaml
    │   └── <özel-tür>.schema.yaml
    ├── tree/                    # bilgi ağacı (klasör = dal)
    │   ├── _node.md             # kök özet
    │   ├── backend/
    │   │   ├── _node.md         # dalın özeti
    │   │   └── auth.md          # yaprak (alt düğüm eklenince klasöre dönüşür)
    │   └── ...                  # dallar init sırasında seçilir
    ├── items/                   # her kalem bir klasör
    │   └── 01J9Z...-login-rate-limit/
    │       ├── item.md
    │       └── replies/01J9Z....md
    ├── activity/                # yalnızca eklenen günlük
    │   └── 2026-09-22/<aktör>.jsonl   # aktör başına günde bir dosya: iki kişi aynı dosyaya yazmaz
    ├── drafts/                  # onay bekleyen AI önerileri
    └── .index/                  # SQLite önbelleği (git'e girmez)
```

- Her kayıt tek bir dosyadır. Bu sayede merge çakışmaları azalır.
- `.index/` silinirse `cortexboard reindex` ile dosyalardan yeniden üretilir.
- `.cortex/.gitattributes` satır sonlarını LF'ye sabitler.

## 5. Veri modeli

### 5.1 Bilgi düğümü (Node)
```yaml
id: 01J9Z...
title: JWT yenileme akışı
summary: "Access token 15dk, refresh token 30 gün; refresh rotation aktif."   # ≤ 300 karakter, zorunlu
tags: [auth, security]
links:
  code: [{ file: src/auth/refresh.ts, lines: "10-80" }]   # dosya veya klasör, isteğe bağlı satır aralığı
  items: [01J9Y...]             # ilgili karar/issue
verified_at_commit: a1b2c3d     # bilginin doğrulandığı commit (koda bağlı düğüm yazılınca otomatik)
status: active | deprecated
updated_by: claude-code
updated_at: 2026-09-22T10:15:00Z
---
(detay gövdesi: markdown)
```
- Yol dosya konumundan gelir (`backend/auth/jwt-refresh`); parçalar küçük harf, rakam ve tire.
- "Eskimiş" (stale) durumu dosyaya yazılmaz, git'ten hesaplanır (Bölüm 9). "Taslak" durumu `drafts/` altındaki öneridir (Bölüm 8).

### 5.2 Kalem (Item) türleri
Tüm türler ortak alanları paylaşır (`id, type, title, status, category_path, author, assignee, tags, links, fields, created_at, updated_at, updated_by`); türe özel alanları, durumları ve geçişleri `rules/*.schema.yaml` tanımlar.

| Tür | Durumlar | Hazır kurallar |
|---|---|---|
| `task` | backlog → todo → doing → review → done | yalnızca insan "done" yapar |
| `issue` | open → in_progress → review → closed | severity + kategori zorunlu; `fixed` yanıtı commit ve dosya listelemeli |
| `question` | open → answered → closed | başkası yanıtlayınca "answered" olur; `blocking` sorular önce gelir |
| `note` | active → archived | |
| `decision` | proposed → accepted / rejected → superseded | AI önerebilir, kabul/ret yalnızca insanda (ADR: bağlam, alternatifler, sonuçlar) |

- Atama: bir aktör, `@humans` veya `@ai`.
- Yeni tür: `rules/<tür>.schema.yaml` dosyası bırakmak yeter.
- Her kalemin yanıt zinciri vardır; yanıtlar da şemaya tabidir.

### 5.3 Aktivite
```json
{"id":"01J9...","actor":"claude-code","action":"fix","summary":"Login'e rate limit eklendi","why":"issue 01J9Y... gereği","files":["src/auth/login.ts"],"commit":"d4e5f6a","refs":["01J9Y...","backend/auth"],"at":"2026-09-22T10:20:00Z"}
```
- Eylemler ve "neden zorunlu" listesi `rules/activity.schema.yaml`'dadır (varsayılan: code_change, fix, refactor, config, deploy için `why` zorunlu).
- Cortex'in kendi denetim kayıtları (`node.updated`, `node.deleted`, `draft.*`, `item.*`, `rules.updated`) `system: true` ve yapılandırılmış `meta` (tür, eski/yeni durum, taslak türü, öneren) taşır; raporlar buradan sayar.

### 5.4 Aktör
`cortex.config.yaml` içinde tanımlanır: `{ id: "ali", kind: "human" }`, `{ id: "claude-code", kind: "ai" }`. Token'lar git'e girmeyen `.secrets.yaml`'dadır. Her istek bir aktör token'ı taşır, kimin ne yaptığı her zaman bellidir. Tam login sistemi ekip sunucusuyla gelecek.

## 6. Kademeli yükleme (token ekonomisinin kalbi)

AI şu sırayla çalışır:

1. **`GET /api/brief`** (oturum başı, **800 tokenin altında**, testle korunur):
   - Projenin tek paragraflık özeti ve üst dallar (1 satırlık özet, alt düğüm ve açık kayıt sayısı)
   - **Bu aktöre yönelik** gelen kutusu, onay bekleyen taslaklar ve eskimiş bilgi: hepsi "sayı + ilk 5"
   - Son aktiviteler, arama modu (keyword/hybrid)
   - Global kurallar (ilk kural yazım dilidir) ve `rules_version`
2. **`GET /api/tree/{path}?depth=1`**: Bir dalın çocuklarını yalnızca özetleriyle getirir.
3. **`GET /api/node/{path}`**: Yalnızca gerektiğinde tam detayı ve eskime bilgisini getirir.
4. **`GET /api/search?q=...`**: Anlamadığı her yerde arama yapar. Sonuçlar tam içerik değil, `path/id + summary + skor + nasıl eşleşti` döner.

Listeleme uçlarında `limit/cursor` sayfalama ve `budget=` (yaklaşık token bütçesi; cevap sığacak kadar kesilir) bulunur.

## 7. Kendini anlatan API ve kurallar

- Her kalem türünün bir şeması vardır (`rules/<tür>.schema.yaml`): zorunlu alanlar, alan formatları, izinli durum geçişleri, yalnızca insanın koyabileceği durumlar, yanıt kuralları ve AI'a yönelik düz dil talimatları.
- **Yazım dili** bir kuraldır: `rules/_global.yaml` içindeki `language: tr`. `init --lang` ile belirlenir (verilmezse bilgisayarın dili), brief'te ilk kural olarak her AI'a gider.
- Her cevapta bir `_meta` alanı bulunur:
  ```json
  "_meta": { "rules_version": "r-7f3a1c2e" }
  ```
  AI, `rules_version` değişmediyse kuralları yeniden çekmez. Böylece token harcanmaz.
- Geçersiz bir yazım denemesinde sunucu yalnızca hata döndürmez, **hangi kuralın ihlal edildiğini ve doğru örneği** de döndürür (`error.hint`). İzin verilmeyen bir durum geçişinde buradan hangi durumlara gidilebileceği söylenir. AI bu sayede kendini düzeltir.
- Kuralları **yalnızca `human` aktörler** değiştirebilir (panel veya dosya). Panelden kaydedilen kural önce denetlenir; bir yazım hatası tüm yazımları bozamaz. AI kural değişikliğini yalnızca `@humans`'a soru açarak önerebilir.

Örnek şema parçası:
```yaml
type: issue
statuses: [open, in_progress, review, closed]
category_required: true
fields:
  severity: { type: enum, values: [low, medium, high, critical], required: true }
reply:
  fields:
    resolution: { type: enum, values: [fixed, wontfix, needs_info, duplicate, cannot_reproduce] }
  require_when:
    - { when: { resolution: fixed }, require: [commits, files] }
transitions:
  open: [in_progress, closed]
  in_progress: [review, open, closed]
ai_instructions: >
  Bir issue'yu 'fixed' kapatırken commit hash'i ve değişen dosyaları ekle.
  Emin olmadığın durumda kapatma, soru aç.
```

## 8. Onay politikası (AI yetkisi)

`cortex.config.yaml` içinde tür bazında belirlenir (`auto` = direkt yazılır, `review` = taslak olur, `human_only` = AI yazamaz). `init` varsayılanı:
```yaml
approval:
  node: review       # bilgi ağacı değişiklikleri taslak olarak düşer
  task: auto
  issue: auto
  question: auto
  note: auto
  decision: auto     # kabul/ret zaten yalnızca insanda, öneri direkt görünür
```
- `review` olan yazımlar `drafts/` altına kaydedilir ve panelde "Onay bekleyenler" listesine düşer. İnsan tek tek ya da **toplu** onaylar veya reddeder. Toplu onayda üst düğümler önce onaylanır; biri hata verirse (ör. çakışma) diğerleri devam eder.
- Taslaktan sonra hedef değiştiyse onay reddedilir (409), insan farkı görüp zorlayabilir.
- AI aynı düğüme yeniden taslak önerirse eski taslağının yerine geçer.
- Taslak bilgi **aramada** "taslak" etiketiyle (`status: "draft"`, `draft_id`, `proposed_by`) görünür.
- Bilgi düğümünü **yalnızca insan silebilir**; kök, alt düğümü olan dal ve altında açık kayıt olan düğüm silinmez. Silinen düğüm git geçmişinde kalır.
- Kurallar her zaman `human_only`'dir.

## 9. Kod bağı ve eskime tespiti

- Düğümler dosya/klasör ve isteğe bağlı satır aralığıyla koda bağlanır; koda bağlı bir düğüm yazılınca o anki commit `verified_at_commit` olarak kaydedilir.
- Sunucu git geçmişine bakar: bağlı kod o commit'ten sonra değiştiyse (satır aralığı varsa yalnızca o satırlar) düğüm **eskimiş** sayılır; değişen dosya, commit sayısı, son commit, yazar ve mesajı gösterilir. Silinen ve taşınan dosyalar ayrıca raporlanır. Kaydedilmemiş değişiklikler sayılmaz.
- Bu bilgi dosyalara yazılmaz, git'ten hesaplanır. HEAD 5 saniyede bir kontrol edilir; açık pano yeni commit'te kendiliğinden güncellenir.
- Eskimiş düğümler brief'te, aramada, ağaçta ve panoda görünür. "Hâlâ doğru" (`verify`) içeriği değiştirmeden doğrulama noktasını HEAD'e taşır; AI yaparsa onaya düşer. **Eskimiş dokümanın ilacı budur.**
- `GET /api/code?files=` ters aramadır: "Bu dosyaları hangi bilgi, karar ve açık iş kapsıyor?" AI aktivite bildirirken değiştirdiği dosyaları anlatan düğümler cevapta listelenir.
- Git deposu değilse bu özellik kapalı kalır, gerisi aynen çalışır.

## 10. Arama

- Kelime araması SQLite FTS5 ile yapılır; Türkçe harfler katlanır ("kullanici" → "Kullanıcı"). Önce tüm kelimeler, sonuç yoksa anlamlı kelimelerden herhangi biri aranır.
- Anlamla arama açıksa iki sıralama Reciprocal Rank Fusion (k=60) ile birleştirilir; her sonuç `keyword`, `semantic` veya `both` ile nasıl bulunduğunu söyler.
- Aranan: bilgi düğümleri, onay bekleyen bilgi taslakları, kalemler (yanıtlarıyla) ve aktivite.
- Filtreler: `kind` (node, item, activity), `path` (dal altı), `status`, `type`.
- Her yazımda ve dosya izleyiciyle yakalanan elle düzenlemede indeks güncellenir; anlam vektörleri yalnızca değişen metinler için arka planda hesaplanır.
- Model yoksa veya yüklenemezse sistem kelime aramasıyla çalışmaya devam eder.

## 11. Gelen kutusu (soru-cevap akışı)

- Sistem kendi başına hiçbir LLM çağırmaz.
- İnsan, bir aktiviteye, düğüme veya karta "Bunu neden böyle yaptın?" diye soru bırakır (`ask`). Soru, sorulan şeyi yapan aktöre atanır.
- AI bir sonraki oturumda `brief` içinde "Sana yönelik 2 soru var" bilgisini görür ve cevaplar.
- Ters yön de aynıdır: AI emin olmadığında insana soru açar ve **cevap gelene kadar o konuda varsayım yapmaz**.
- Gelen kutusunda neler var: sana veya grubuna atananlar, cevaplanan soruların, yazdığın kayıtlara gelen yeni yanıtlar, (insanlar için) onay bekleyen kararlar. Engelleyici sorular önce, sonra en son güncellenen.

## 12. Arayüzler

### 12.1 REST API (temel katman)
Tüm uçlar `Authorization: Bearer <token>` ister (pano: oturum çerezi + `x-cortex-csrf` başlığı) ve yalnızca localhost'a cevap verir.
```
GET    /api/brief
GET    /api/tree/{path}?depth=&budget=
GET    /api/node/{path}            PUT /api/node/{path}        DELETE /api/node/{path}?reason=   (silme: yalnızca insan)
GET    /api/stale                  POST /api/verify/{path}
GET    /api/code?files=a,b
GET    /api/search?q=&kind=&path=&status=&type=&limit=&budget=
GET    /api/items?type=&status=&assignee=&author=&path=&open=&limit=&cursor=
POST   /api/items                  GET/PATCH /api/items/{id}   POST /api/items/{id}/replies
POST   /api/ask                    { about, title, body?, blocking? }
GET    /api/inbox
POST   /api/activity               GET /api/activity?since=&actor=&ref=&include_system=   GET /api/activity/{id}
GET    /api/rules[/{name}]         GET/PUT /api/rules/{name}/source   (yazma: yalnızca insan)
GET    /api/approvals[/{id}]       POST /api/approvals/{id}/approve|reject
POST   /api/approvals/approve      { ids, force? }      POST /api/approvals/reject  { ids, reason? }
GET    /api/report?since=7d&until=&format=md&lang=tr
GET    /api/events                 (panonun canlı güncelleme akışı, SSE)
```

### 12.2 MCP sunucusu
Aynı çekirdeğin ince bir sarmalayıcısıdır: `cortex_brief`, `cortex_tree`, `cortex_node`, `cortex_search`, `cortex_code_context`, `cortex_verify_node`, `cortex_update_node`, `cortex_rules`, `cortex_inbox`, `cortex_items`, `cortex_item`, `cortex_create_item`, `cortex_update_item`, `cortex_reply`, `cortex_ask`, `cortex_log_activity`, `cortex_activity`, `cortex_report`.
Kurulum: `npx cortexboard mcp --actor ai-agent` (stdio). Örnek: `claude mcp add cortex -- npx cortexboard mcp --actor ai-agent`.
Merkezde ayrıca HTTP ucu vardır: `POST <url>/mcp/p/<proje>`, `Authorization: Bearer <ajan tokenı>` (durumsuz JSON-RPC). Bu bilgisayarda çalışmayan AI'lar (ör. ChatGPT) böyle bağlanır; token, rol ve görünürlük REST ile aynı boru hattından geçer.
Ekip sunucusundaki bir proje için: `npx cortexboard mcp --hub <url> --project <id> --token <ajan tokenı>` (ya da `CORTEX_HUB_URL`, `CORTEX_PROJECT`, `CORTEX_TOKEN`). Araçlar birebir aynıdır: MCP araçları proje REST API'sini konuşur (yerelde süreç içinde, merkezde HTTP ile), böylece kurallar, rol ve görünürlük iki yolda da aynen uygulanır.

### 12.3 Web pano (`http://localhost:4747`)
- **Bildirimler:** seni bekleyen her şey sayıyla ve düz cümleyle: işi durduran sorular, sana atananlar, grubunu bekleyenler, cevaplanan soruların, yeni yanıtlar, onay bekleyen kararlar ve taslaklar, eskimiş olabilecek bilgi.
- **Pano:** tür başına kanban; kolonlar kurallardaki durumlar, yasak geçişler soluk ve açıklamalı.
- **Bilgi:** ağaç gezgini (özet → detay), eskimiş/açık kayıt rozetleri, düzenle, alt düğüm ekle, sil.
- **Aktivite:** AI ne yaptı, neden, hangi dosya; canlı. Her satırda "Bunu sor" düğmesi.
- **Onaylar:** mevcut ve önerilen yan yana; tek tek veya toplu onay/ret.
- **Raporlar:** Bölüm 15.
- **Kurallar:** şemaları ve genel kuralları görüntüleme ve düzenleme (yalnızca insan).
- **Kılavuz:** sistem nasıl işler, AI nasıl bağlanır (komut sunucuya ve projeye göre hazır yazılır), roller ve görünürlük, mobil ekip örneği, İngilizce terimler sözlüğü. Panoda kalan İngilizce terimlerin üstüne gelince açıklaması çıkar.
- **Arama çubuğu** her ekranda. TR/EN, açık/koyu tema. Giriş: `cortexboard login` ile 10 dakikalık imzalı bağlantı, şifre yok.

## 13. İlk kurulum akışı

```bash
npx cortexboard init      # .cortex/ oluşturur: dalları sorar, varsayılan kuralları koyar
npx cortexboard start     # API + pano + dosya izleyici
```
- `init` seçenekleri: `--lang tr` (AI'ların yazım dili; varsayılan bilgisayarın dili), `--branches backend,frontend,odeme` (terminalde sormadan dal seçimi; şablon: backend, frontend, server, mobile, security, seo, code-structure; yeni adlar da kabul edilir), `--agent-files`. Rapor saat dilimi bilgisayardan alınıp `cortex.config.yaml`'a yazılır.

`init` sonrasında:
1. Mevcut `.md` dosyaları (README, docs/, CLAUDE.md vb.) taranır ve "içe aktarım adayları" olarak listelenir.
2. `init` bu görevi `@ai`'a atanmış bir **görev kaydı** olarak açar ("Bilgi ağacını koddan doldur (ilk kurulum)", etiket `bootstrap`): "Projeyi tara, ağacı kur, her dala özet yaz, kararları çıkar, çelişkileri soru olarak aç." Görev yazım dilini de söyler. İlk bağlanan AI (yerelde ya da hub üzerinden) onu gelen kutusunda bulur; kök özeti henüz yazılmadıysa brief'in `next` alanı yalnızca bu görevi gösterir. `cortexboard bootstrap` aynı metni elle vermek için yazdırır. AI görevi API/MCP üzerinden yapar; bilgi yazımları taslak olarak düşer.
3. İnsan panelden (toplu) onaylar. Uymayan dalları siler.
4. `--agent-files` verilmişse projedeki mevcut `CLAUDE.md` veya `AGENTS.md` dosyasına **tek bir kısa blok** eklenir: "Bu projede bilgi kaynağı Cortex'tir. Oturum başında `cortex_brief` çağır, değişiklikten önce `cortex_search` yap, değişiklikten sonra `cortex_log_activity` gönder." Bundan sonra `.md` dosyalarında doküman güncellenmez.

## 14. AI çalışma protokolü (her AI'a öğretilecek)

1. Oturum başında `brief` çağır, sonra `inbox`. Sana yönelik soruları ve issue'ları gör, önce onları cevapla.
2. Bir değişiklikten önce ilgili konuyu `search` ile ara, gerekirse ilgili dala in. Tüm ağacı okuma. Düzenleyeceğin dosyalar için `code_context` çağır.
3. Anlamadığın bir yerde önce ara. Sonuç yoksa insana `question` aç, varsayım yapma.
4. Kod değiştirdikten sonra `activity` gönder (ne, neden, dosyalar, commit, ilgili kalem).
5. Mimari veya davranış değiştiyse ilgili düğümü güncelle veya `decision` aç. Eskimiş düğümleri kontrol et: değiştiyse güncelle, değilse doğrula.
6. Kurallara ve yazım diline uy. `rules_version` değiştiyse kuralları yeniden çek.

## 15. Raporlar

- Dönem: `7d`, `30d`, `90d`, `2w` veya tarih aralığı; en fazla 366 gün. Göreli dönemler **projenin saat diliminde** takvim gününe hizalıdır ("7 gün" = bugün + önceki 6 gün). Saat dilimi `cortex.config.yaml` → `timezone` (ör. `Europe/Istanbul`); yoksa UTC.
- İçerik: AI ve insan aktivitesi (günlük), AI'ın gerekçeli/gerekçesiz değişiklikleri, açılan/kapanan kayıtlar, soruların cevaplanma süresi, kararlar, AI taslak onay oranı (güven göstergesi), issue yaşı, bekleyen onaylar, eskimiş ve belgelenmemiş bilgi, aktör bazında tablo.
- Hepsi sayılarak hesaplanır, LLM yok. Erişim: pano (grafikler + tablo görünümü), REST (JSON veya TR/EN markdown), MCP `cortex_report`, CLI `cortexboard report`.

## 16. Ekip sunucusu (hub)

Tek sunucu, birden çok proje, ekip üyeleri ve AI ajanları. `cortexboard start` (tek proje, yalnızca localhost) olduğu gibi kalır.

- **Veri:** Her projenin bilgisi kendi reposundaki `.cortex/` klasöründe kalır (git dostu ilke korunur). Merkez (`~/.cortex/hub`, hiçbir repoya girmez) SQLite'ta yalnızca kişileri, şifre özetlerini (scrypt), oturumları, tek kullanımlık davetleri, AI ajanlarını (token özetleri), kayıtlı proje klasörlerini ve proje üyeliklerini tutar.
- **Giriş:** Kişiler e-posta + şifre (en az 10 karakter). Yönetici kişiyi ekler, sistem 48 saat geçerli tek kullanımlık bir davet bağlantısı üretir; kişi şifresini kendisi belirler. Aynı bağlantı şifre sıfırlama için de kullanılır ve diğer oturumları kapatır. Oturum çerezi httpOnly, SameSite=Lax; Secure bayrağı `cookie_secure` ayarıyla, verilmezse hub yalnızca loopback'te dinlemiyorsa açık (vekil arkasında `trust_proxy: true` ile `x-forwarded-proto: https` de sayılır); yazımlar CSRF başlığı ister. Aynı adres ve e-postadan 15 dakikada 10 hatalı şifre, aynı adresten 10 hatalı ajan token'ı (REST ve MCP) ya da 20 geçersiz davet bağlantısından sonra o kapı 15 dakika kapanır. `allowed_hosts` tanımlıysa listenin kendisidir; localhost için ayrıca istisna yoktur.
- **AI ajanları:** Organizasyon yöneticisi ekler; token bir kez gösterilir, yalnızca özeti saklanır, yenilenebilir. Ajanlar `/api/p/<proje>/` altındaki REST uçlarını `Authorization: Bearer <token>` ile kullanır.
- **Roller (proje başına):** İnsanlar için Sahip, Yönetici (her şey), Üye (kayıt ve bilgi yazar, taslak onaylar), İzleyici (okur, soru sorar ve cevaplar). AI için Okuyucu (okur), Katkıcı (kayıt yazar, bilgi yazımları taslağa düşer), Güvenilir (bilgiye doğrudan yazar). AI hiçbir rolde onaylayamaz, kural değiştiremez, üye yönetemez. Organizasyon yöneticileri her projede Sahip sayılır; projenin son sahibi çıkarılamaz, sahipliği yalnızca sahipler değiştirir.
- **Görünürlük:** Her üyelik "her şeyi" ya da "yalnızca kendi kayıtlarını" (yazdığı, kendisine veya grubuna atanan) görür; isteğe bağlı dal kısıtı (ör. yalnızca `frontend`) bilgi ağacını, düğümleri, kayıtları, aramayı, aktiviteyi, gelen kutusunu, brief'i ve canlı olayları süzer. Gizli olan 404 döner; kısmi görünüm proje raporu alamaz.
- **Web:** `/` projelerim, `/admin` organizasyon (kişiler, AI ajanları, projeler), `/p/<proje>/` proje panosu (proje değiştirici, Üyeler sayfası), `/invite/<token>` şifre belirleme.
- **AI bağlantısı:** `cortexboard mcp --hub <url> --project <id> --token <t>`; MCP araçları merkezdeki proje API'sini kullanır, rol ve görünürlük aynen geçerlidir.
- **Komutlar:** `cortexboard hub init | start | add-project <klasör> [--init --lang tr --branches a,b] | invite <e-posta>`. İnternete açılacaksa HTTPS arkasında (ters vekil) çalıştırılır ve `public_url` https adrese ayarlanır.

## 17. Kapsam

**v1 (tamam):** Bölüm 4–15, tek proje, yerel çalışma, basit aktör kimliği.

**Tamamlanan (v1 sonrası):** CI (Windows, macOS, Linux), ekip sunucusu, çoklu proje, e-posta + şifre ile giriş, rol ve görünürlük (Bölüm 16).

**Sonra:**
- npm yayını
- SSO (GitHub/Google), e-postayla davet gönderimi
- İsteğe bağlı anlık AI cevabı (kullanıcının kendi API anahtarıyla)
- Webhook'lar, GitHub Issues/PR senkronizasyonu
- VS Code eklentisi

## 18. Kabul kriterleri (v1 "bitti" sayılır, eğer)

- [ ] Temiz bir Windows, macOS ve Linux makinede, yalnızca Node kuruluyken `npx cortexboard init && npx cortexboard start` 2 dakikadan kısa sürede çalışıyorsa — *CI ile doğrulanacak*
- [x] `brief` cevabı örnek bir projede 800 tokenin altında kalıyorsa — *testle korunuyor, 30 taslakla bile*
- [x] Hibrit arama Türkçe ve İngilizce sorgularda ilgili düğümü ilk 3 sonuçta getiriyorsa — *sahte (deterministik) modelle test ediliyor*
- [x] Şemaya aykırı bir yazım, ihlal edilen kural ve doğru örnekle reddediliyorsa
- [x] `review` türündeki AI yazımları onaysız aktif olmuyorsa
- [x] Bağlı dosya değiştiğinde düğüm `stale` işaretleniyorsa — *gerçek git deposunda gerçek commit'lerle test ediliyor*
- [x] `.index/` silinip `reindex` çalıştırıldığında hiçbir veri kaybolmuyorsa
- [x] Claude Code MCP üzerinden, Bölüm 14'teki protokolü baştan sona uygulayabiliyorsa — *`test/protocol.test.ts`: yalnızca MCP araçlarıyla brief → gelen kutusu → arama → kod bağlamı → değişiklik → aktivite → güncelle/doğrula → onay, gerçek git deposunda*
- [x] İki geliştirici `.cortex/` üzerinde paralel çalışıp git merge yaptığında veri bozulmuyorsa — *`test/parallel-merge.test.ts`: iki klon aynı gün, aynı aktörlerle yazıyor, `git merge` çakışmasız, yeniden kurulan indeks iki tarafı da içeriyor. Test ilk yazıldığında kırmızıydı: aynı aktörün aynı günkü günlüğü add/add çakışması veriyordu; `.cortex/.gitattributes`'a `activity/**/*.jsonl merge=union` eklendi*
