---
title: İndeks ve kelime araması
summary: node:sqlite önbelleği, sürüm başına ayrı dosya (.index/cortex-v<N>.db);
  FTS5 kelime araması, Türkçe harfler katlanır, gerekirse köklerle. İndeks
  yazımda ve açılışta artımlı güncellenir (dosya damgaları). Kalem satırı pano
  kartını ve rapor alanlarını taşır.
links:
  code:
    - file: src/index/db.ts
    - file: src/core/sync.ts
    - file: src/core/cortex.ts
    - file: src/store/activity.ts
    - file: src/store/items.ts
verified_at_commit: cc149dd0cae36b68c5266c7f525830a8753159a5
id: 01M34QY9AVGX8V5NP7DDB49TM1
status: active
updated_by: ai-agent
updated_at: 2026-09-28T10:23:16.000Z
---

- `src/index/db.ts`: `node:sqlite`, WAL, `synchronous = NORMAL` (her commit'te fsync yok; güç kesilirse son yazımlar kaybolabilir ama dosya bozulmaz, kaybolan dosyalardan yeniden kurulur).
- **Sürüm başına ayrı dosya:** `.index/cortex-v${INDEX_VERSION}.db` (şu an 11: milestone). Eskiden tüm sürümler `cortex.db`'yi paylaşıyordu; aynı projede iki sürüm çalışınca (kaynaktan hub + npm'den `cortexboard@0.4.0` MCP) en son açan tabloları düşürüp kendi şemasıyla kuruyor, diğerinin yazımları "table items has N columns but M values were supplied" ile düşüyordu (dosyalar yazılıyor, indeks ve dolayısıyla pano/arama/inbox geride kalıyordu). Artık her sürüm kendi dosyasını tutar ve izleyicisiyle (`Cortex.watch`) dosyalardan güncel kalır. Aynı dosyada `user_version` uyuşmazsa tablolar yine düşürülüp yeniden kurulur. Eski `cortex.db` 0.4.0 ve öncesi için yerinde bırakılır; eski sürüm dosyaları silinmez.
- Yeni bir indeks dosyası ilk açılışta en yeni eski dosyanın `embeddings` tablosunu devralır (`adoptEmbeddings`, ATTACH + `INSERT OR IGNORE`): gömmeler yalnız metin özeti ve modele bağlı, yeniden hesaplamak pahalı. Kilitli/okunamayan dosya sessizce atlanır. Test: `test/index-file.test.ts`.
- FTS5 sanal tablosu `docs_fts`, `tokenize = 'unicode61 remove_diacritics 2'`. Türkçe harfler katlandığı için "kullanici" araması "Kullanıcı"yı bulur. Sıralama bm25, başlık ve özet daha ağır.
- `doc_text` her belgenin `docs_fts` satır numarasını (`fts_rowid`) tutar. `deleteDoc` rowid ile siler; eskiden `kind`/`ref` (UNINDEXED) ile sildiği için her kalem yazımı tüm FTS tablosunu tarıyordu. `insertDoc` önce eskisini siler, bir belgeye iki arama satırı düşmez.
- `items` tablosu: kalem alanlarının yanında kurallardan gelen `terminal` ve `open_work` bayrakları, `reply_count`, pano kartı için `attachment_count`, `cover`, `level` (`fields.priority`, issue'da `fields.severity`), `due`, `has_body`; raporlar için `severity`, `answered_at`/`answered_by` (yazar dışından ilk yanıt) ve `resolution` (son yanıttaki `fields.resolution`); `checklist_done`/`checklist_total`; `milestone`. `reportItems()` ve `nodeSummaries()` raporu dosya okumadan besler.
- Kalemin arama metni gövde + metin alanları + yanıtlardır. İstisna: kör turdaki bir tartışmanın (`isSealed`, `src/core/discussions.ts`) yanıtları indekse girmez. Kural `insertItem` içinde olduğu için yazım, senkron ve tam kurulumun hepsinde geçerli.
- `queryItems` `blocking DESC, updated_at DESC` sıralar; isteğe bağlı `visible` (`SqlFilter`, hub'da `Access.itemSql()`) LIMIT/OFFSET'ten önce uygulanır.

## Sorgu adımları (`Index.search`)
Her kelime önek olarak aranır (`"kelime"*`). Sırayla:
1. **Tüm kelimeler, yazıldığı gibi** (AND). Sonuç varsa biter.
2. **Tüm kelimeler, kökleriyle** (AND; her kelime `("kelime"* OR "kök"*)`). `stem()`: sondan en çok 3 harf atar, 5 harfin altına inmez.
3. Sayfa dolmadıysa **herhangi bir kelime** (OR, dolgu sözcükleri hariç) kalan yeri doldurur.
- Kökler bilerek yalnızca 2. adımda (ölçüm: `docs/BENCHMARKS.md`, 5. tur, commit 9b26efb).
- Bilinen sınır: İngilizce soruyla Türkçe kaydı kelime araması bulamaz (`backend/semantic-search`).

## Artımlı güncelleme (`src/core/sync.ts`)
Bir dosya değiştiğinde (elle düzenleme, `git pull`, başka bir Cortex süreci) yalnızca o dosyanın işaret ettiği kayıt yeniden indekslenir.
- `mapPath(rel)` saf bir fonksiyon: yolu kayda çevirir (düğüm, kalem (yanıt ve ekler dahil), günlük dosyası). Önce NFC'ye çevrilir, ayırıcılar normalize edilir.
- **Kayıt düzeyinde çalışır:** değişen dosyalar bir kayıt kümesine çevrilir, her kayıt store'dan yeniden okunur — varsa `upsert`, yoksa `delete`.
- Kayda bağlanamayan değişiklik (klasör olayı, kaybolan günlük dosyası, adsız FS olayı) → tam `reindex()`.
- Bozuk tek bir dosya yalnızca kendi kaydını atlar.
- Kural dosyası değişince `retermItems` yalnızca `terminal`/`open_work` bayraklarını yeniden hesaplar.

## Açılışta artımlı (`Cortex.openIndex`)
- `file_stamps(path, stamp)`: `.cortex` altındaki `rules/ tree/ items/ activity/ drafts/` dosyalarının `mtime:size` değeri. `reindex()` damgaları okumadan önce alır (okuma sırasında değişen dosya bir sonraki açılışta yine değişmiş görünür, tersi olmaz).
- Açılışta damga yoksa (yeni ya da sürümü yükselmiş indeks) tam kurulum. Varsa `stampFiles` ile disk listelenir, `changedFiles` farkı `SyncService.run`'a verilir.
- Damgalar yalnız son açılışta var olan dosyaları bilir. Oturumda oluşturulup kapalıyken silinen dosya için `missingRecords` indeksteki kalem/düğüm/taslak kümesini diskle karşılaştırır; indekste olup diskte olmayan günlük dosyası (`at`'in ilk 10 karakteri + aktör) tam kurulum ister.
- Okunamayan kayıt varsa damgalar yazılmaz, sonraki açılış yeniden dener.
- Kalan maliyet listeleme + `stat`: Windows'ta 2.300 klasör / 3.800 dosya ≈ 1,4 sn (eskiden tam kurulum 5,6 sn).

## Ölçülen davranış
2026-09-27, `scripts/seed-large.ts` ile 1.500 kalem / 600 düğüm / 15.000 aktivite, Windows, Node 24: açılış 5,6 sn → 1,4 sn; rapor 6 sn → 0,12 sn; kalem oluşturma 9 ms'den büyüyerek → sabit ~4 ms (klasör taraması, FTS taraması, her çağrıda şema YAML ayrıştırması ve fsync kalktı). Yanıt ~9 ms, sabit (dosya G/Ç'si).

2026-09-23 arama ölçümü: 50 kat veriye karşılık 1,8 kat gecikme (100 düğüm p50 12,9 ms; 5.000 düğüm p50 22,7 ms).
