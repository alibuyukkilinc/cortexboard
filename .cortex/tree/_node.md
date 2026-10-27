---
title: Cortex
summary: İnsan ve AI için ortak proje beyni. Bilgi ağacı, pano, kararlar,
  sorular, tartışmalar, ekler ve AI'ın yaptıkları repodaki .cortex/ klasöründe
  durur. Tek proje için yerel çalışır; ekip için bir sunucu (hub) çok projeyi,
  kişileri, AI ajanlarını ve rolleri yönetir. Hiç LLM çağırmaz.
links:
  code:
    - file: src/core/cortex.ts
    - file: CORTEX_SPEC.md
    - file: README.md
verified_at_commit: 0075bcc9666bd04ac2944f61708fce36ad012dac
id: 01M34Q1CBAV6VRTFKAVCK99EC0
status: active
updated_by: ai-agent
updated_at: 2026-09-24T20:09:04.657Z
---

## Ne işe yarar?
Dağınık ve eskiyen `.md` dosyalarının yerine, repoda duran tek bir doğruluk kaynağı koyar (`.cortex/`).
AI bilgiyi **yukarıdan aşağı** okur: önce kısa özet (brief), sonra dal (tree), en son tek düğüm (node). Böylece her şeyi birden yüklemez, token harcamaz.
Kontrol insandadır: AI'ın bilgiye yazdığı her şey önce taslak olur, insan onaylar.

## Ana parçalar
- **Çekirdek** (`src/core`): `Cortex` sınıfı. REST, MCP ve CLI bunun üstünde ince katmanlardır.
- **Depolama** (`src/store`): düz markdown ve YAML dosyaları, aktivite için JSONL, kalem ekleri kalemin klasöründe düz dosya. Asıl veri dosyalardır.
- **İndeks** (`src/index`): SQLite (node:sqlite) önbelleği ve kelime araması. Silinse de dosyalardan yeniden kurulur.
- **Anlamla arama** (`src/search`): isteğe bağlı, bilgisayarda çalışan çok dilli model.
- **Eskime tespiti** (`src/git`, `src/core/staleness.ts`): bağlı kod değişince bilgi derecesiyle (yüksek/orta/biçimsel) işaretlenir; panoda "Eskimiş bilgi" sayfası.
- **Raporlar** (`src/core/reports.ts`): dosyalardan ve aktivite günlüğünden sayılır.
- **Tartışmalar** (`src/core/discussions.ts`, `backend/discussions`): insanlar ve AI ajanları bir soruda seçenek destekleyen, kanıtlı görüş yazar; kör ilk tur, oy sayımı, çoğunluk önerilen karar olur, kararı insan verir. Cortex burada da LLM çağırmaz: her ajan kendi oturumundan MCP ile katılır.
- **Arayüzler**: REST (`src/api`), MCP (`src/mcp`, 23 araç), CLI (`src/cli.ts`), web pano (`web/`, Trello tarzı kartlar, ayrı Tartışmalar ekranı).
- **Ekip sunucusu** (`src/hub`): çok proje, e-posta + şifreyle giriş, AI ajanları için token, proje başına rol ve görünürlük.

## İlkeler (CORTEX_SPEC.md'den)
Token dostu · tek komutla çalışır · git dostu · kontrol insanda · AI'ın yaptıkları şeffaf · API kendi kurallarını anlatır · basit.

## Markdown dosyaları
`CORTEX_SPEC.md` ana spesifikasyondur ve kodla uyumlu tutulur (sistemin ne yaptığı; kabul kriterleri 8/9 işaretli). `README.md` kullanıcıya yönelik ürün tanıtımıdır. `CHANGELOG.md` sürüm notları (her girdi ölçülmüş önce/sonra ile), `CONTRIBUTING.md` katkı düzeni ve alışkanlıklar, `SECURITY.md` güvenlik bildirimi.
Ayrıntılı proje bilgisi (hangi dosya ne yapar, neden böyle karar verdik) bu ağaçtadır.

## Yayın
npm paketi: **`cortexboard`**, tek komut `cortexboard`. Kurulum: `npx cortexboard init`, sonra `npx cortexboard start`.
Depo: github.com/alibuyukkilinc/cortexboard. Yayın akışı ve sürüm adımları `server` düğümünde.
