# Ölçümler: Cortex bir AI ajanına faydalı mı?

Bu sayfa [BENCHMARKS.md](BENCHMARKS.md)'nin Türkçe özetidir. 1-6. turların ayrıntıları İngilizce
sayfadadır; 7. ve 8. turlar burada da tam olarak yer alır. Her tur olduğu gibi kaydedilir: Cortex'in
aleyhine çıkan sonuçlar da yazılır.

## Kısa sonuç

- Cevap **kararlarda, geçmişte, açık işlerde** duruyorsa (neden böyle yapıldı, kim karar verdi, ne
  reddedildi, ne oldu): Cortex'li ajan aynı tokenla yaklaşık **iki kat doğru** cevap verdi.
- Cevap **kodda** duruyorsa: kodu okumak da aynı derecede iyi.
- **En iyi sonuç ikisinin birlikte kullanımı:** serbest bırakılan ajan Cortex'i harita olarak kullanıp
  yalnız gösterdiği koda indi; en doğru ve en hızlı o oldu.
- **Bilginin kalitesi, aracın kendisinden daha çok fark yaratıyor** (8. tur): onaylanmamış taslaklar ve
  eskimiş bir plan düzeltilince Cortex'li ajan 10 üzerinden 8,5'ten 10'a çıktı; token %14, süre %34,
  araç çağrısı %50 azaldı.

## Özet tablo

| Tur | Tarih | Soru tipi | Doğruluk kod → Cortex | Token kod → Cortex | Çağrı | Süre |
|---|---|---|---|---|---|---|
| 1 | 2026-09-24 | Kodda/CHANGELOG'da da olan 5 bilgi | 4,75 → **5,0** / 5 | **63,1K** → 67,1K | 9 → 13 | 39 sn → **26 sn** |
| 2 | 2026-09-24 | 5 "neden / kim karar verdi / ne açık" | 2,5 → **4,9** / 5 | **62,5K** → 68,3K | 7 → 20 | 41 sn → 43 sn |
| 3 | 2026-09-24 | 2. tur, araç değişikliklerinden sonra | 2,5 → **4,97** / 5 | **62,5K** → 69,4K | 7 → 12 | 41 sn → **35 sn** |
| 4 | 2026-09-24 | Tek büyük tasarım görevi | 11,5 → 11,6 / 12 | **88,1K** → 90,1K | 9 → 27 | **82 sn** → 91 sn |
| 5 | 2026-09-24 | Yalnız arama: anahtar kelime vs. hibrit | 6 → 6 / 6 | 68,2K → 66,3K | 11,5 → 11 | 19 sn → 19 sn |
| 6 | 2026-09-24 | Büyük kod tabanı, zayıf model, tek gerçek soru | 14,5 → **23,5** / 26 | 55,5K* → **3,9K** | 8 dosya → 7 | — |
| 7 | 2026-09-28 | 5 "ne" + 5 "neden" sorusu, büyük özel kod tabanı, 3 grup | 8,25 → 8,5 / 10 | 198,3K → **184,9K** | 49 → 34 | 165 sn → **111 sn** |
| 8 | 2026-09-28 | 7. tur, bilgi düzeltildikten sonra | 8,75 → **10** / 10 | 196,1K → **158,1K** | 44 → 17 | 173 sn → **73 sn** |
| 9 | 2026-09-29 | Bu reponun en yeni değişiklikleri, 5 "ne" + 5 "neden", iki model boyu | 7,0 → **9,25** / 10 | **77,0K** → 81,8K | 24 → 12 | 63 sn → **49 sn** |
| 10 | 2026-09-30 | 8 görevlik çok oturumlu iş (devir, geçmiş, güncel kural, yazma, hata düzeltme, süreklilik), 3 Claude + GPT + 3 OpenCode modeli | 59,6 → **74,4** / 80 | 3.563K → **2.780K** | 147 → 112 | 22,7 dk → **18,7 dk** |

\* 6. tur ajanın tüm bütçesini değil, getirilen bağlamı ölçer (ayrıntı İngilizce sayfada).

## 7. tur: iki soru tipi, üç ajan, aynı özel kod tabanı

6. turdaki özel ürün üzerinde (NestJS + Prisma backend, Next.js 16 frontend, birkaç canlı sunucu), bir
günlük gerçek çalışmanın ardından. Bu kez iki tarafta da Claude alt ajanları ve **üçüncü bir grup** var:
yalnızca soruyu alan, Cortex'i kendiliğinden bulup bulmayacağını görmek istediğimiz bir ajan.

- **Gruplar.** A: yalnız Cortex araçları, kod okumak yasak. B: yalnız kod, script ve config; Cortex
  araçları, `.cortex/` ve markdown belgeleri yasak. C: yalnız soru, hiçbir araç kuralı yok.
- **İki soru seti, her biri 5 soru, paralel koşuldu.**
  - *1. set, "kod ne yapıyor":* aynı gün yazılmış bir özellik (yapay zeka sağlayıcı katmanı): uç ve
    guard'lar, hata kodları, SSRF kontrolü, bir migration tuzağı, bir zaman aşımı. Cevaplar kodda.
    İlgili Cortex düğümü yazılmıştı ama **henüz onaylanmamıştı** (taslak, araçlara görünmez).
  - *2. set, "neden / ne oldu":* bir canlı kesinti, bir çekirdek modülü alarmı ve kaldırılırken ne
    olduğu, pod sınırının arkasındaki bağlantı bütçesi, bir coğrafi kütüphanenin neden reddedildiği,
    bir framework yönlendirme tuzağı. Cevaplar çoğunlukla karar ve olay kayıtlarında.
- **Puanlama.** Soru başına 0–1 (kısmi puan var); cevap anahtarı ajanlar çalışmadan önce Cortex ve kodla
  doğrulandı. Token ve süre çalışma ortamının raporladığı değerler, iki setin toplamı.

| | A: yalnız Cortex | B: yalnız kod | C: yalnız soru |
|---|---|---|---|
| Doğruluk, 1. set ("ne") | 3,75 / 5 | **5 / 5** | **5 / 5** |
| Doğruluk, 2. set ("neden") | 4,75 / 5 | 3,25 / 5 | **5 / 5** |
| **Doğruluk, toplam** | 8,5 / 10 | 8,25 / 10 | **10 / 10** |
| Token | **184,9K** | 198,3K | 196,4K |
| Süre | 111 sn | 165 sn | **110 sn** |
| Araç çağrısı | 34 | 49 | **30** |

- **Tek kaynaklı iki grup berabere kaldı, ama zıt yönlerden.** "Ne" setini kod, "neden" setini Cortex
  kazandı (yarı sürede ve daha az çağrıyla).
- **Serbest ajan iki sette de Cortex'i kendiliğinden buldu,** harita olarak kullandı ve yalnız
  gösterdiği kodu okudu: 10/10, en hızlı.
- **Cortex iki düzeltilebilir sebepten puan kaybetti.** 1. setin ayrıntılı düğümü onaylanmamış taslaktı,
  araçlar göremedi. Bir görev kartı da uygulamada 90 sn'ye çekilmiş bir zaman aşımının *planlanan*
  değerini (120 sn) taşıyordu; yalnız Cortex'e bakan ajan eski değeri yüksek güvenle verdi.
- **Bilgi iki depoya bölünmüştü.** 2. sette serbest ajan, kodlama asistanının kendi yerel hafıza
  dosyalarını da okudu ve Cortex'te olmayan bilgileri (kesintinin kök nedeni, bağlantı hesabının tam
  dökümü) oradan buldu.

## 8. tur: 7. turun bulduklarını düzelttikten sonra aynı sorular

Üç değişiklik, ardından birebir aynı istemler:

1. Taslaklar onaylandı.
2. Görev kartındaki plan, uygulamayla eşitlendi.
3. Yalnız asistanın yerel hafızasında duran dokuz kalıcı bilgi (olay raporları, deploy ve CDN
   tuzakları, CSS/yerleşim tuzakları) Cortex'e not olarak taşındı. Parola, IP adresi ve token değerleri
   taşınmadı.

| | A: yalnız Cortex | B: yalnız kod | C: yalnız soru |
|---|---|---|---|
| Doğruluk, 1. set | **5 / 5** | **5 / 5** | **5 / 5** |
| Doğruluk, 2. set | **5 / 5** | 3,75 / 5 | **5 / 5** |
| **Doğruluk, toplam** | **10 / 10** | 8,75 / 10 | **10 / 10** |
| Token | **158,1K** | 196,1K | 170,4K |
| Süre | **73 sn** | 173 sn | 87 sn |
| Araç çağrısı | 17 | 44 | **15** |

Önce → sonra, yalnız Cortex grubu:

```
                 7. tur                                          8. tur
Doğruluk (/10)   8,5     ██████████████████████████████████░░░░░░  10      ████████████████████████████████████████
Token            184,9K  ████████████████████████████████████████  158,1K  ██████████████████████████████████        −%14
Süre             111 sn  ████████████████████████████████████████  73 sn   ██████████████████████████                −%34
Araç çağrısı     34      ████████████████████████████████████████  17      ████████████████████                      −%50
```

- **Yalnız bilgi değişti ve en çok Cortex grubu ilerledi:** 8,5'ten 10'a; %14 daha az token, üçte bir
  daha kısa süre, yarı yarıya daha az araç çağrısı. Yalnız koda bakan gruba göre artık her soruyu
  cevaplıyor, %19 daha az tokenla ve yarıdan kısa sürede.
- **Yalnız kod grubu neredeyse yerinde saydı (8,25 → 8,75);** beklenen buydu, kodda bir şey değişmedi.
  Küçük artışı, çalışma ortamının her ajana yüklediği asistan hafıza dizininden geldi (testin tasarımındaki
  bir sızıntı, aşağıda not edildi).
- **Serbest ajan 10/10'da kaldı ama yolu değişti:** 2. sette Cortex araçlarını çağırmak yerine hafıza
  dosyalarını ve `.cortex/` dosyalarını doğrudan okudu (toplam 3 araç çağrısı). Cevap doğru; yol,
  ajanların hangi depo en yakındaysa onu kullandığını gösteriyor.

Çekinceler: grup ve set başına tek koşu (n=1); puanlamayı işi de yapan tek kişi yaptı; asistanın hafıza
dizini her ajanın bağlamında vardı, bu da 2. sette B ve C gruplarına yardım etti. 6. turla aynı ürün ama
farklı model ailesi (Claude alt ajanları), iki tur doğrudan kıyaslanamaz. Katsayı değil, yön.

## 9. tur: bu reponun en yeni değişiklikleri, iki model boyu

Bu repoda, bir günlük değişikliğin hemen ardından koşuldu: bilginin repo yerine hub'da tutulması, eskime
uyarısının sessize alınması, AI bilgi yazımlarının onaysız geçmesi ve kaydedilen işe karar kontrolü. Her
değişiklik yapılırken kaydedildi, ilgili bilgi sayfası da güncellendi.

- **Ajanlar.** A: Opus, yalnız Cortex. B: Opus, yalnız kod, test ve config (Cortex, `.cortex/`, markdown
  ve git geçmişi yasak). C: Opus, yalnız soru. D: Haiku, yalnız Cortex. E: Haiku, yalnız kod. Beşi
  paralel, kurallar dışında aynı istem.
- **Sorular.** 1. set ("ne", cevap kodda): hub bir projenin bilgisini nerede tutar, eskimenin varsayılan
  seviyesi, `hub move-knowledge` açık tutulan klasörde ne yapar, bir değişiklik hangi kararlara karşı
  kontrol edilir, yeni ajanın varsayılan rolü. 2. set ("neden", cevap kararlarda ve kayıtta): bilgi neden
  hub'a taşındı, eskime neden susturuldu (%88), AI yazımları neden onaysız (214/0), eksik beyan neden
  reddedilmiyor, bir projenin taşınmasında ne ters gitti.
- **Puanlama.** Soru başına 0–1, kısmi puan var; anahtar koşudan önce kod ve Cortex'le doğrulandı. Token,
  süre ve araç çağrısı çalışma ortamının raporladığı değerler.

| | A: Opus, Cortex | B: Opus, kod | C: Opus, serbest | D: Haiku, Cortex | E: Haiku, kod |
|---|---|---|---|---|---|
| Doğruluk, 1. set ("ne") | 4,5 / 5 | 4,75 / 5 | **5 / 5** | 4,5 / 5 | 3,75 / 5 |
| Doğruluk, 2. set ("neden") | **4,75 / 5** | 2,25 / 5 | **4,75 / 5** | 4,5 / 5 | 1,75 / 5 |
| **Doğruluk, toplam** | 9,25 / 10 | 7,0 / 10 | **9,75 / 10** | 9,0 / 10 | 5,5 / 10 |
| Token | 81,8K | 77,0K | 81,6K | **69,2K** | 78,2K |
| Süre | 49 sn | 63 sn | **44 sn** | 86 sn | 103 sn |
| Araç çağrısı | **12** | 24 | 13 | 21 | 22 |

```
Doğruluk (/10)
A  Opus  + Cortex   9,25  █████████████████████████████████████░░░
B  Opus  + kod      7,0   ████████████████████████████░░░░░░░░░░░░
C  Opus  + serbest  9,75  ███████████████████████████████████████░
D  Haiku + Cortex   9,0   ████████████████████████████████████░░░░
E  Haiku + kod      5,5   ██████████████████████░░░░░░░░░░░░░░░░░░
```

- **"Neden" sorularında Cortex belirleyici.** Cortex'le 4,75 ve 4,5 / 5, yalnız kodla 2,25 ve 1,75 / 5:
  gerekçeler ve arkalarındaki sayılar (%88 eskimiş, 214 onay 0 ret) kodda yok.
- **En çok zayıf model kazanıyor.** Haiku Cortex'le 9,0, kodla 5,5 aldı; Haiku + Cortex, Opus + kodu
  geçti. Yalnız kodla bir soruyu (yeni ajanın rolü) yanlış cevaplayıp "yüksek güven" yazdı.
- **Token aşağı yukarı aynı, iş değil.** Yalnız Cortex'e bakan Opus, yalnız koda bakanın yarısı kadar
  araç çağırdı ve %22 daha kısa sürede bitirdi.
- **En iyisi yine serbest ajan (9,75).** Cortex'i harita olarak kullandı, bir soru için bir kod dosyası
  okudu, bir kez git geçmişine baktı. 7. ve 8. turla aynı desen.
- **Cortex'in kaybettiği yer: süreç sırası.** İki Cortex ajanı da `move-knowledge` adımlarını ters
  sırayla anlattı. Kayıt "önce yeniden adlandıracak şekilde düzeltildi" diyordu ama sırayı hiçbir sayfa
  yazmıyordu.

Aynı gün, projelerin kendisinden, gerçek geçmişleri üzerinde yeniden hesaplanan iki ölçü:

| | aimcp | app-web | app-api | finance | shop |
|---|---|---|---|---|---|
| Gösterilen eskime uyarısı, tüm seviyeler → yeni varsayılan | 25 → 1 | 10 → 0 | 5 → 0 | 3 → 0 | 8 → 0 |
| Kaydedilen değişiklik başına sorulan karar, sınırdan önce | 15,3 | 4,7 | 1,8 | 1,3 | 0 |
| Kaydedilen değişiklik başına sorulan karar, en fazla 5 | 4,6 | 3,8 | 1,7 | 1,3 | 0 |

Karar kontrolü bu repoda önce her değişiklikte yaklaşık 15 karar soruyordu, çünkü kararların çoğu en üstteki
`backend` dalına dosyalanmıştı. Yalnız en yakın atayı sormak hiçbir şeyi değiştirmedi (ağaçlar iki seviye
derin); kontrol artık en fazla beş karar soruyor, en özgülden başlayarak, gerisini listeliyor.

Çekinceler: ajan başına tek koşu (n=1). Soruları puanlayan, sorulan işi yapan ve o gün Cortex'e yazan aynı
kişi; bu Cortex'in lehine. Oturumun kendi Cortex bağlantısı sabahki kodla çalışıyordu. Yalnız kod grupları
git geçmişini okuyamadı; bazı gerekçeler commit mesajlarında.

## 10. tur: çok oturumlu iş, yedi model, üç araç

İlk kez soru-cevap değil, **iş akışı** ölçüldü ve ilk kez Claude dışında bir aile (GPT) de koştu. Düzenek,
sonuçlar ve etkileşimli rapor repoda: `bench/` (rapor: `bench/report/index.html`,
`node bench/report/serve.mjs`).

- **Kollar.** *Cortex ile*: bu repo, `.cortex/` bilgisiyle ve yayındaki cortexboard 0.6.0'ın MCP
  araçlarıyla. *Cortex'siz*: aynı kod, `.cortex/` bütün git geçmişinden silinmiş.
- **Görevler.** Sekiz görev sırayla, **her biri ayrı ve temiz bir oturumda** (sohbet belleği, otomatik
  bellek, alt ajan, internet kapalı): T1 devir alma, T2-T3 "neden"/geçmiş hata, T4 eskimiş karar tuzağı,
  T5 değişiklik öncesi kod bağlamı, T6 sahibin kararını ve işi kaydetme, T7 iki kolda da aynı masum
  commit'e ekilmiş saat dilimi hatasını düzeltme (test + gizli test), T8 yeni oturumda T6-T7'nin
  kayıtlarını bulma.
- **Ajanlar.** Haiku 4.5, Sonnet 5.5, Opus 5.5 (Claude Code 2.1.284), GPT-6 Astra (Codex 0.158), hepsi
  medium akıl yürütme; ve OpenCode 2.0.14 ile üç ücretsiz model (big-pickle, muse-spark-1.3, mimo-v2.6-flash; nemotron-3-ultra ve
  longcat-2.5 araç çağırmadan cevapladıkları için elendi). Fable 5.1 bu hesapta kredi
  istediği, Antigravity'nin arayüzsüz modu olmadığı için koşulamadı.
- **Puan.** Otomatik: cevaptaki olgular, testler, dosya değişiklikleri, kod dışı kayıt. Kontroller
  koşulardan sonra iki kez düzeltildi ve bütün sonuçlara yeniden uygulandı; T4 cevaplarının hepsi elle
  okundu.

| Model | Cortex ile | Cortex'siz | Token (ile / siz) | Süre (ile / siz) |
|---|---|---|---|---|
| Haiku 4.5 | **57** / 80 | 41 | **2,37M** / 3,31M | **12** / 15 dk |
| Sonnet 5.5 | **80** | 59 | **1,91M** / 2,69M | **8** / 11 dk |
| Opus 5.5 | **80** | 72 | **2,34M** / 3,02M | 16 / **11** dk |
| GPT-6 Astra | **78** | 69 | **2,10M** / 2,23M | 14 / **13** dk |
| OpenCode · big-pickle | **77** | 59 | **4,95M** / 5,79M | 38 / 38 dk |
| OpenCode · muse-spark-1.3 | **70** | 59 | **2,34M** / 2,82M | 11 / 11 dk |
| OpenCode · mimo-v2.6-flash | **79** | 58 | **3,45M** / 5,09M | **32** / 59 dk |

Görev ortalaması, yedi model (Cortex'siz → Cortex ile, /10): T1 **2,4 → 8,9**, T4 2,9 → 7,1, T6 8,3 → 9,7;
geri kalanlarda fark 0-1 puan. muse-spark Cortex ile de T4'te eskimiş kurala düştü (0/10): Cortex bu
tuzağı her modelde kapatmıyor. OpenCode Cortex araçlarını çoğunlukla bir kod aracının (`execute`) içinden
çağırdı; çalışma klasörünü `PWD`'den aldığı için ilk denemede gerçek repoyu okudu (yakalandı, düzeltildi).

- **Fark devirde ve güncel kuralda.** Cortex'siz ajanlar incelemede bekleyen işleri ve makinedeki
  ortam değişkeni tuzağını koddan çıkaramadı. Eskimiş kararda Cortex'siz Haiku ve Sonnet "taslak
  kalır" dedi; Cortex'siz Opus ve GPT doğruyu kod ve CHANGELOG'dan çıkardı.
- **Zayıf model süreklilikten en çok kazanıyor.** Cortex'siz Haiku kararı kaydetti ama işi açmadı; sonraki
  oturum karar da iş de bulamadı (T8: 4/10, Cortex ile 9/10).
- **Aleyhte olanlar.** Opus ve GPT Cortex ile daha yavaştı. GPT salt okuma görevlerinde de
  `cortex_update_status` çağırdı. Cortex'li Haiku, Cortex'in kendi eskimiş kural metnine ("yazımların
  taslak olur") güvenip T4'ü yanlış cevapladı: bu metin kural dosyasında, `init` şablonunda ve
  `CLAUDE.md`'de duruyor, geçerli ayar `auto` (iş açıldı).
- **Test alanının dışı.** Ajanlar izin sormadan çalıştığı için ev dizinini görebildi. Cortex'siz GPT, T1'de
  ortam değişkenlerinden yerel hub'ı, oradan gerçek repoyu bulup gerçek `.cortex`'i okudu: görev
  geçersiz sayıldı (10 → 0). Artık canlı token'lar ajanlara geçmiyor ve kaçışlar otomatik tespit ediliyor.

## Şimdiye kadar öğrendiklerimiz

1. Cortex, cevabın kodda olmadığı yerde kazandırıyor: neden karar verildi, kim verdi, ne reddedildi, ne
   açık, ne eskidi. Orada aynı tokenla yaklaşık iki kat doğruluk.
2. Kod zaten söylüyorsa kodu okumak da aynı derecede iyi, biraz daha ucuz.
3. Araçların şekli göründüğünden önemli: iki küçük API değişikliği Cortex araç çağrısını %41 azalttı.
4. Kod tabanı büyüyünce hesap değişiyor (6. tur): cevabı tutan dosyalar 222 KB iken zayıf bir model aynı
   soruyu bağlamın on dörtte biriyle %56 yerine %90 doğrulukla cevapladı. En pahalı hata yanlış bir bilgi
   değil, ekibin zaten reddedip yazdığı bir karara aykırı öneriydi.
5. Cortex ve kod birbirinin yerine değil, tamamlayıcı (7. tur): tek başlarına aşağı yukarı aynı puanı
   aldılar ama farklı sorularda. Seçmekte serbest bırakılan ajan ikisini de kullandı, en doğru ve en
   hızlı oldu.
6. Bilginin kalitesi, aracın kendisinden daha çok fark yaratıyor (8. tur). Taslakları onaylamak, eskimiş
   bir planı düzeltmek ve dokuz bilgiyi özel bir hafıza dosyasından taşımak, yalnız Cortex'e bakan ajanı
   10 üzerinden 8,5'ten 10'a çıkardı; token %14, süre üçte bir azaldı. Onaylanmamış taslak ajan için
   yoktur; eskimiş bir değer ise güvenle cevaplanır.
7. İkinci bir depoda (asistanın özel hafızası) kalan bilgi gerçeği böler: ajanlar hangisi yakınsa onu
   okur. Cortex'in karşılığını veren şey tek ve güncel tutulan bir depo.
8. Anlamla arama, bugünkü hâliyle ajanlara ölçülebilir kazanç getirmedi; isteğe bağlı ve kapalı kalıyor.
9. Bilgi, model boyunun açığını kapatıyor (9. tur). Cortex'li küçük model 10 üzerinden 9,0, yalnız koda
   bakan büyük model 7,0 aldı. Küçük model yalnız kodla bir yanlışa "yüksek güven" yazdı.
10. Cortex'in çıkardığı her uyarının bir gürültü bütçesi olmalı (9. tur). Eskime bilginin %88'ini
    işaretliyordu ve görmezden geliniyordu; ilk karar kontrolü değişiklik başına 15 karar sordu. Bir
    kontrolü yayınlamadan önce yükünü gerçek geçmiş üzerinde ölç.
