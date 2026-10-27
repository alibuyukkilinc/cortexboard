---
title: Bilinen tuzaklar
summary: "node:sqlite: FTS5 ancak Node 22.16'dan itibaren; numaralı parametre
  yok. git Türkçe yolları tırnaklar, macOS NFD verir. typescript-eslint TS 7'yi
  desteklemez. DOMPurify blob: adreslerini atar. Fastify JSON ayrıştırıcısı ham
  yüklemede engel. Windows'ta Python CRLF yazar."
links:
  code:
    - file: src/index/db.ts
    - file: src/git/git.ts
    - file: src/cli.ts
verified_at_commit: 0075bcc9666bd04ac2944f61708fce36ad012dac
id: 01M34QYABJE3KGV82NE6BGAWEK
status: active
updated_by: ai-agent
updated_at: 2026-09-24T20:09:06.618Z
---

- **En düşük Node 22.16**: 22.13-22.15'teki node:sqlite FTS5 içermiyor, Cortex hiç açılmıyordu.
- **node:sqlite parametreleri**: `?1` gibi numaralı yer tutucular çalışmıyor; `:ad` ya da düz `?` kullan.
- **LIKE ve alt çizgi**: `_` joker gibi eşleşir; kod bağlantısı aramaları birebir karşılaştırır, görünürlük SQL'i dal adlarını `ESCAPE '\'` ile kaçışlar.
- **git ve Türkçe karakterli yollar**: git ASCII dışı yolları tırnaklayıp sekizli kaçışla yazar (`"src/\303\266deme.ts"`); `Git.run` her çağrıda `-c core.quotepath=false` verir ve çıktıyı NFC'ye çevirir.
- **NFC/NFD**: macOS dosya adlarını ayrışık bildirir. Bağlı dosya yolları, kod bağlamı girdisi, izleyici yolları, git çıktısı ve ek adları NFC'ye çevrilir.
- **ExperimentalWarning**: `src/cli.ts` SQLite uyarısını gizler; ondan önce hiçbir şey node:sqlite yüklememeli.
- **Taşıma tespiti**: `git diff` bağlı yolla sınırlanınca taşınan dosyanın yeni yeri görünmez; silinmiş görünenler için ayrıca kontrol edilir.
- **HEAD kontrolü**: 5 saniyede bir; Windows'ta her git çağrısı ~20-45 ms. Eskime git cevaplarını HEAD başına önbelleğe alır; biçim kararları blob çiftine göre diske yazılır.
- **"Yalnızca biçim" tespiti**: `git diff -w` Prettier'ın yaptığını (satır bölme, sondaki virgül, gereksiz parantez, tırnak) biçim saymaz; S8 süpürgesinde 22 düğümün hepsi orta/yüksek çıkmıştı. Çözüm projenin kendi Prettier'ına sormak (`backend/staleness`).
- **Lint ve TypeScript 7**: typescript-eslint TS'in JS API'sini ister (peer <6.1), TS 7'de o API yok; lint oxlint `--type-aware` ile (karar `01M3837TYN730SW3BRBT5YWDAX`). `label-has-associated-control` varsayılanda metni ifade olan etiketleri (`{t("...")}`) atlar; `assert: "htmlFor"` gerekir. Girdiyi saran bir `<label>` da `htmlFor`/`id` ister.
- **Ham dosya yükleme ve Fastify**: `application/json` gövdesi JSON ayrıştırıcısına gider; ek yükleme kapsamında `removeAllContentTypeParsers()` + tek bir bayt ayrıştırıcı (`"*"`, `parseAs: "buffer"`) kullanılır, yoksa .json dosyası yüklenemez.
- **DOMPurify ve blob:**: varsayılan izinli adres listesi `blob:` içermez; yeni kayıt penceresinde henüz yüklenmemiş resimler boş görünüyordu. Yalnızca o durumda `ALLOWED_URI_REGEXP`'e `blob` eklenir.
- **Escape ve iç içe pencereler**: her pencere kendi Escape dinleyicisini kursaydı önizleme çekmeceyle birlikte kapanıyordu; `useEscape` artık bir yığın, yalnızca en üstteki kapanır.
- **Performans ölçümü**: `new Cortex` kalem klasörü haritasını zaten ısıtır; "soğuk reindex" kare maliyeti göstermez, taze bir `ItemStore` ile ölçülmeli.
- **Statik dosyalar ve yeniden derleme**: `@fastify/static` `wildcard: true`, eksik dosyada 404. Tarayıcı eski `index.html`'i tutabilir: `npm run build` sonrası sayfa yenilenmezse eski paket çalışmaya devam eder.
- **Brief boyutu**: 800 token sınırı testle korunuyor.
- **SSE ve dinleyici uyarısı**: 11. panoda `MaxListenersExceededWarning`; `/events` sınırı (50) ile `setMaxListeners` ayarlanır.
- **Taslak zamanlaması**: bir düğüm taslağını yazdıktan sonra aynı dosyalara kod commit'lenirse onay onu HEAD'e taşımaz, eskimiş kalır. Taslakları kod durulduktan sonra yaz; geç kaldıysan Onaylar'da "HEAD'de doğrula".
- **Test ortamında bağlantı klasörü**: `node_modules`'a bağlantı (Windows junction) açan test, temizlikten önce bağlantıyı `unlinkSync` ile kaldırır; özyinelemeli silme bağlantının içine yürümesin.
- **Windows'ta betikle dosya düzenleme**: Windows Python'u metin kipinde `\n`'i `\r\n` yazar. `.gitattributes` (`eol=lf`) commit'te düzeltir ama çalışma kopyasında Prettier kontrolü dosyanın tamamını farklı görür ve `grep -c $'\r'` bunu göstermeyebilir (`file` gösterir). `open(..., newline="\n")` kullan ya da sonra `sed -i 's/\r$//'`.
- **Araç sayısı iki yerde**: yeni MCP aracı eklenince `test/interfaces.test.ts` (ad listesi) ve `test/hub.test.ts` (sayı, iki yerde) birlikte güncellenir.
