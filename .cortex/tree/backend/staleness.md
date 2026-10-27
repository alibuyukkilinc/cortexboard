---
title: Kod bağlantıları ve eskime tespiti
summary: "Düğümler koda bağlanır, yazılınca commit'e sabitlenir. Kod değişirse
  eskir: yüksek (bağlı satır, silme, taşıma), orta (dosyanın başka yeri), düşük
  (yalnızca biçim). Ne gösterileceğini `staleness` ayarı seçer: varsayılan
  `high`, hub'daki bilgide `off`, `all` hepsi."
links:
  code:
    - file: src/git/git.ts
    - file: src/git/formatting.ts
    - file: src/core/staleness.ts
    - file: web/src/pages/Stale.tsx
verified_at_commit: 50ee58d26e243ad672a7598569aca86f9f2a6d5b
id: 01M34QY9MHTMEP4XJH25MGX34H
status: active
updated_by: chat-gpt-new
updated_at: 2026-09-29T13:26:43.427Z
---

## Ne gösterilir (karar `01M3MXCREN98XN2E1VABABQTSR`)
- `cortex.config.yaml` → `staleness: all | high | off`. `StalenessService.level()` okur; `get()` ve `list()` seviyeye göre süzer. Brief, pano ("Eskimiş bilgi" sayfası ve sayaç), rapor, arama/ağaçtaki `stale` durumu, `cortex_node` uyarısı ve `cortex_log_activity` ipucu hep bu iki fonksiyondan beslendiği için tek filtre hepsini susturur.
- Varsayılan: bilgi repodaysa (`dir` = `root/.cortex`) **`high`**; hub klasöründeyse **`off`**. Gerekçe: dosya düzeyindeki uyarılar yoğun dosyalarda neredeyse hep gürültüydü (bu repoda 28 düğümün 23'ü).
- Süzme yalnızca gösterimdir: kod bağlantıları ve `verified_at_commit` yazılmaya devam eder; `staleness: all` her şeyi geri getirir. Taslak onayındaki "dosyalar değişti" koruması (`changesSince`) ayardan etkilenmez.
- Testler: `gitProject()` eskime mekaniğini sınamak için `all` kurar (`opts.staleness` ile değişir); varsayılanlar `test/staleness.test.ts` içindeki seviye testinde.

## Mekanik
- `Git` (`src/git/git.ts`) git komutunu `-c core.quotepath=false` ile çağırır, çıktıyı NFC'ye çevirir; hata olursa "bilinmiyor" sayar.
- `StalenessService` bağlı yollar için `verified_at_commit..HEAD` farkına bakar; satır aralığı varsa yalnızca o satırlara dokunan değişiklikleri sayar. Git cevapları HEAD başına önbellekte.
- `refresh(force, checkHead)`: normalde 3 sn kısıtlanır; `checkHead` kısıtlamayı atlar ve yalnızca HEAD değiştiyse yeniden hesaplar. `cortex_log_activity` dosya bildirince bunu kullanır: AI commit'ten saniyeler sonra kaydettiği için aksi halde eski HEAD'i görüp "değişikliğin şunları eskitti" demiyordu (protokol testi buldu).
- Derece (`severity`): **yüksek** = dosya silinmiş/taşınmış ya da bağlı satır aralığına dokunulmuş; **orta** = aralıksız bağlı dosya gerçekten değişmiş, ya da sabitlenen commit artık yok; **düşük** = yalnızca biçimsel.
- "Yalnızca biçim mi?" (`Git.formattingOnlyPairs`): 1) `git diff -w --ignore-blank-lines --quiet`; 2) normalize edilince aynı mı (`sameCode`); 3) biçimleyicinin ekleyip silebileceği karakterler atılınca farklıysa kesin gerçek değişiklik; 4) projede Prettier varsa iki sürüm projenin ayarıyla biçimlenir (`src/git/formatting.ts`, tek alt süreç). Karar blob çiftine göre `.cortex/.index/formatting.json`'da saklanır.
- `actionable(s)` = düşük değil ve ertelenmemiş. Brief, gelen kutusu, ağaç, `codeContext` ve menü sayacı yalnızca bunları sayar.
- Erteleme: yalnızca insanlar (`POST/DELETE /api/snooze/<path>`), `.cortex/.index/snoozes.json`, git'e girmez; aynı dosyalara yeni commit gelince kendiliğinden kalkar.
- Onay: taslak önerildiği commit'e sabitlidir; bağlı dosyalar o arada değişmediyse onayda HEAD'e sabitlenir, değiştiyse eski sabitleme kalır ve `stale_after_approval` döner (`backend/approval`).
- Kaydedilmemiş değişiklikler sayılmaz. Bağlı dosya yolları NFC.
- `verifyNode` / `verifyMany` (`POST /api/verify`): içeriği değiştirmeden sabitlemeyi HEAD'e taşır. AI yaparsa taslak olur.

## İncelemede: sembol bağlantıları ve satır kayması (2026-09-29)
`gpt/code-symbols` dalı, commit `5808476fa2a7990e5cdee28eb243dc326c78620f`, görev `01M3P47Y3438GT6W6KSD3F7JZF`. Henüz main'e birleştirilmedi; aşağıdaki davranış bu daldadır.
- `NodeInput.links.code[]` ve MCP `cortex_update_node.code_files[]`, isteğe bağlı `symbol` alır. İndeks sürümü 12, bu alanı yeniden kurulabilir SQLite önbelleğinde taşır.
- `src/git/symbol.ts` bağımlılıksız bildirim tarayıcısıdır: fonksiyon, sınıf, const/let/var bildirimlerini eşler. İki commit'teki bildirim aynıysa aynı dosyanın başka yerindeki değişiklik düğümü eskitmez. Sembol değişirse yüksek, yalnız biçimse düşük eskime üretir.
- Bulunamayan, birden fazla bulunan veya tarayıcının çözemediği semboller sessizce dosya düzeyine düşer. Tam TypeScript ayrıştırıcısı değildir; düzenli ifade içeren bildirimler, karmaşık generic/dönüş tipleri gibi belirsiz durumlar bu kapsamdadır. `symbol` ile `lines` birlikte verilirse sembol önceliklidir.
- Satır karşılaştırması eski commit'in koordinatlarını kullanır; eklemeler iki eski satır arasında sayılır. Üste veya aralığın hemen sonrasına ekleme eskime üretmez; aralığın içindeki ekleme/değişiklik üretir. `--inter-hunk-context=0`, kişisel git ayarının dış değişiklikleri tek geniş blokta birleştirip yanlış eskime üretmesini önler.
- Kayma, düğüm dosyasına veya doğrulama commit'ine yazılmaz. `high/all/off` gösterim politikası değişmedi.
- Doğrulama: typecheck, tip bilgili oxlint, Prettier temiz; tüm paket 278 başarılı, 1 atlanan test. Gerçek git depolarında satır ekleme/sınır/iç değişiklik, fonksiyon/sınıf/const, başka sembol değişimi, bulunamayan sembol ve MCP üzerinden taslak onayında sembolün korunması sınandı.
