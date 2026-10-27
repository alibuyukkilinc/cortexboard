---
title: Pano sayfaları
summary: Her sayfa web/src/pages altında. Kalem çekmecesi ve yeni kayıt
  penceresi items.tsx'te, ekler attachments.tsx'te; filtreler (URL'de) ve
  kayıtlı görünümler filters.tsx'te. Boş sayfalar EmptyState, yükleme iskelet
  satırlar.
links:
  code:
    - file: web/src/pages
    - file: web/src/items.tsx
    - file: web/src/attachments.tsx
    - file: web/src/SchemaForm.tsx
    - file: web/src/hub.tsx
    - file: web/src/ui.tsx
    - file: web/src/filters.tsx
verified_at_commit: 12d17270529dc142a060db242ca64bd6f576ec4e
id: 01M34QY9ZWPSMQ85J1ACFRTWTS
status: active
updated_by: ai-agent
updated_at: 2026-09-28T04:29:44.469Z
---

- **Proje durumu kartı** (`web/src/StatusCard.tsx`): Bildirimler'in en üstünde; `useStatus()` sayfada çağrılır ve sayfa onu da bekler (kart sonradan gelip listeyi itmesin; özet satırı da aynı nedenle iskeletin yerine gelen içeriğin içinde). Eskimişse turuncu çerçeve, rozet ve açıklama; `write_knowledge` yetkisinde yerinde düzenleme. Kısıtlı üyede (403) kart yok.
- Bildirimler (`pages/Inbox.tsx`): sunucunun kurduğu tek kuyruğu (`GET /api/inbox`, insanda kayıt + taslak + eskimiş bilgi, `by_reason` sayılarıyla) tek istekle çizer. Gruplar işleme göre: işi durduran sorular, kontrolünü bekleyen işler (`review`), onay bekleyen taslaklar, kararlar, görüşünü bekleyen tartışmalar, sana atananlar, grubunu bekleyenler, cevaplanan soruların, yeni yanıtlar, eskimiş bilgi. Satırdan hızlı işlem (`approve` yetkisinde): Onayla / Geri gönder (not karta yanıt olur), taslakta Onayla / Reddet, kararda Kabul et / Reddet. Düğmeler satırın kardeşi (`.inbox-row` > `ListRow` + `.row-actions`), telefonda alta iner. Çözülen satır hemen düşer, sayılar sunucunun yenilemesi gelene kadar yerelde düzeltilir. Tartışma satırı çekmece yerine tartışma ekranını açar.
- **Canlı yenileme türe göre** (`web/src/api.ts`): `useApi(path, { on: [...] })` yalnız SSE olayının `kind`'ı listede ise (ya da `reindex`/`archive`/`rules` gelince) yeniden çeker; `on` verilmezse her olayda. Yeni bir liste eklerken hangi türleri gösterdiğini yaz, yoksa her yazımda boşuna indirilir.
- **Filtreler URL'de** (`web/src/filters.tsx`, UI-10): `useRouteQuery()` hash'teki sorguyu okur ve `replaceState` ile yazar (Geri sayfadan çıkar, son filtreye dönmez). Filtreli sayfa yer imi, paylaşım ve kayıtlı görünüm olabilir. Ortak parçalar: `BranchPicker` (ağacı indirmez, `GET /api/branches?q=` ile önerir), `PersonSelect` (`groups` ile @humans/@ai), `UpdatedSelect` (URL'de göreli `updated=7d`, sunucuya `sinceOf()` ile gün tarihi gider; istek gün içinde değişmez), `SavedViews` (sayfanın görünüm çipleri + "Görünümü kaydet"; `before`/`focus` gibi geçici parametreler kaydedilmez).
- Pano (`pages/Board.tsx`): başlıkta sayfa adı, türün açıklaması ve tek ana eylem ("Yeni"); altında tür sekmeleri (`.type-tabs`, filtreleri koruyarak tek tıkla tür değişir), dal, atanan, yazan ve değişiklik tarihi filtreleri (`.board-filters`), bağlantıyla gelen `?milestone=` kaldırılabilir bir çip olarak (Raporlar'ın zaman çizelgesinden), sonra kayıtlı görünümler. **Tüm tür indirilmez:** `GET /api/board` sütun başına bir sayfa ve `total` döner; sütun başlığı toplamı gösterir, "Daha fazla göster" 25'er büyütür, 100 kartta durur ve "N kaydın 100 tanesi, filtreleri daraltın" der (eskiden 500 üstü sessizce kayboluyordu). İstek en derin açılmış sütun kadar ister ki canlı yenileme yüklenenleri kaybetmesin. Trello tarzı kart: ilk resim eki kapak, öncelik (issue'da önem) renkli etiket, son tarih rozeti (geçtiyse kırmızı, bugünse turuncu, bitince yeşil), açıklama / yanıt / ek rozetleri, sağda atanan. Her sütunun altında "Kart ekle": başlık + Enter, kart o sütuna düşer, giriş açık kalır. Kartta "Şuraya taşı" menüsü (klavye ve dokunmatik için sürüklemenin karşılığı), taşıma `aria-live` ile duyurulur. Sürüklerken gidilemeyen sütun `.column.dimmed`. `discussion` türü panoda ve yeni kayıt penceresinde yok.
- **Sütunlar kendi içinde kayar:** pano sayfası pencereyi doldurur, her sütun görünür alana göre kendini sınırlar, kart listesi kayar ve "Kart ekle" altta kalır. Kartlara `flex-shrink: 0` verilmesi şart.
- **Arama** (`pages/Search.tsx`): kaynak (bilgi / kayıt / aktivite), kayıt türü, yazan, atanan, değişiklik tarihi ve dal filtreleri `q` ile aynı URL'de; tür ya da atanan seçilince kaynak "kayıt" olur. Üst çubuktan yeni arama, arama sayfasındayken filtreleri korur (`App.tsx`).
- **Aktivite** (`pages/Activity.tsx`): kişi, tarih ve denetim kayıtları filtreleri URL'de; 50'lik sayfalar, "Daha eski" sunucunun `next_cursor`'ını `before` olarak URL'ye yazar, "En yeniye dön" siler. Başka yerden `?focus=<id>` ile gelinirse sayfa o kayıttan başlar (`before=<id>~`).
- **Raporlar** (`pages/Reports.tsx`): varsayılan bu hafta, hafta gezinmesi, milestone zaman çizelgesi ve epik listesi; ayrıntı `backend/reports`. Aktörler tablosu telefonda kendi kartında yatay kayar (`.table-scroll`, odaklanabilir bölge).
- **Tartışmalar** (`pages/Discussions.tsx`, `backend/discussions`):
  - Liste (`#/discussions`): Sürenler / Tümü filtresi, kart ızgarası. Kartta durum, "Görüşünü bekliyor" işareti, seçenekler ve oy çubukları (kör turda sayısız), katılımcı avatarları (yazmayan soluk). Boşsa "Yeni tartışma" eylemli boş durum.
  - "Yeni tartışma" penceresi: soru, arka plan, 2-8 seçenek, katılımcı seçimi (boşsa herkes), son tarih, bilgi dalı, kör ilk tur (varsayılan açık).
  - Detay (`#/discussions/<id>`): üstte aşama açıklaması; "Seçeneğe göre" ya da "Akış" görünümü; görüş kartında tür, güven, desteklenen seçenek ve kanıt bağlantıları. Kör turda başkalarının görüşleri kilitli kart.
  - Görüş kutusu aşamaya göre tür sunar: açıkken Görüş ve Yorum, tartışılırken İtiraz ve Sentez de.
  - Sağ panel: oylar, katılımcılar, karar. "Görüşleri aç", "Oyları say", "Tartışmaya geri dön", "İptal et" (`write_items`); önerilen kararı "Kabul et" ve seçenek başına "Bununla karar ver" yalnızca `approve` yetkili insanda. Önerilen seçenekle "Bununla karar ver" mevcut öneriyi kabul eder.
  - Kalem çekmecesi bir tartışma açılırsa kendini kapatıp tartışma ekranına yönlendirir.
- **Boş ve yükleniyor durumları** (`EmptyState`, `Loading`, `web/src/ui.tsx`): her boş durum `EmptyState` (UI-12'de hub'ın proje ve kullanım ekranları, ajan tablosu, Bilgi sayfası ve Raporlar panelleri de); eski `.empty` sınıfı kullanılmıyor.
- Kalem çekmecesi (`items.tsx`): üstte Durum ve Atanan seçicileri (tek başına değiştirir). Açıklama yerinde düzenlenir (Yaz / Önizle), altında Ekler ızgarası (önizleme penceresi: resim, işlenmiş Markdown, metin; indir / açıklamaya ekle / kaldır). Ekran görüntüsü yapıştırmak ya da dosya sürüklemek eke dönüşür; Markdown'daki `files/<ad>` aynı kalemin ekini gösterir. Görev ve issue formunda `milestone` alanı (UI-11).
- **Geçmiş** (`web/src/ItemHistory.tsx`): çekmecenin altında, açılınca yüklenir. Sürüm satırı: ne zaman, kim, değişen kısımlar; açılınca şimdiki halle `DiffView` farkı ve "Bu sürüme dön" (onay penceresi, durum aynı kalır). Açık satır zeminle değil sol kenarla işaretlenir (çipler boyalı zeminde AA'nın altına düşüyordu). Açıklamayı yarıdan fazla kısaltan kişiye önce sorulur.
- **Yanıt kutusunun altındaki durum seçicisi yazı istemez:** hiçbir şey yazılmadıysa düğme "Şuraya taşı: <durum>" olur ve kartlardaki ile aynı PATCH'i yapar.
- Yeni kayıt penceresi: aynı yapıştır / bırak / seç; dosyalar tarayıcıda bekler (blob: önizleme), kayıt oluşunca yüklenir.
- Bilgi: ağaç (ad bir bağlantı, `aria-current`; açma/kapama ayrı düğme; dokunmatikte satırlar 44 px), markdown, kod bağlantıları; eskimiş düğümde derece, "Hâlâ doğru", "Düzelt" ve (insanlar için) "Ertele".
- **Eskime bandı** (`StaleBanner`, UI-8): "Kod farkını göster" (`GET /api/stale/diff/*`, `PatchView`), "AI'dan güncelleme iste" (`POST /api/stale/request-update/*`, açık istek varsa onu döndürür). Stale sayfasında seçip toplu doğrulama.
- Eskimiş bilgi (`pages/Stale.tsx`): dereceye göre gruplar, satır başına Doğrula / Düzelt / Ertele, "biçimsel olanların hepsini doğrula".
- **Onaylar** (`pages/Approvals.tsx`): liste sayfalı (`limit`), satırda "−40 +2" boyutu ve riskli taslakta "Çok siliyor"; riskli satırın kutusu kapalı, "tümünü seç"e girmez (sunucu da toplu onayda `risky_draft` ile reddeder). Satır kutuları (burada ve Arşiv'de) `.row-check-hit` etiketinin içinde: dokunmatikte 44 px vuruş alanı. Çekmece: riskli uyarısı, gerekçe, alanlar için önce/sonra tablosu, gövde için `DiffView` (`web/src/DiffView.tsx`: birleşik / yan yana, telefonda birleşik, kelime vurgusu `<del>`/`<ins>`, katlanan değişmeyen satırlar, ilk 200 satır hemen). Fark hesabı `src/core/diff.ts` (sunucu ve pano ortak). Onaydan sonra kod değişmişse "HEAD'de doğrula".
- Onay/sebep soruları `useAsk` penceresiyle (`web/src/ui.tsx`), `confirm()`/`prompt()` kullanılmaz. Ad soran pencerede `input.line` tek satırlık alan verir (Enter gönderir).
- Kurallar, Hub ekranları, Kılavuz: önceki gibi.
- **Markdown'da kimlikler** (`Markdown`, `linkRefs` in `web/src/ui.tsx`): ULID'ler bağlantı olur (kod bloğu hariç), üzerine gelince/odaklanınca önizleme kartı; bir metnin bütün kimlikleri tek `GET /api/refs` isteğiyle, sayfa geneli önbellekle. Dinleyiciler `useEffect` ile DOM'a bağlanır (bağlantılar React öğesi değil).
- **Onay kutuları** (UI-6): `Progress` çubuğu pano kartında, Bildirimler satırında, çekmecede ve Raporlar'ın epik listesinde; çekmecede `Markdown checklist={{ lines, onToggle }}` kutuları tıklanabilir yapar (satırlar `parseChecklist`'ten, sayı tutmazsa salt okunur), `PATCH /items/:id/checklist` `if_rev` ile.
- **Okuma yardımları** (UI-7, `enhance`): kod bloğunda Kopyala, tablolar `role=region` içinde kaydırılır, "Kabul kriterleri" bölümü kutuda; uzun yanıtlar `Fold` ile katlanır. Kişiye atanmış görevde `DonePanel`: adım ilerlemesi, kanıt (satır başına commit ya da bağlantı), "Yaptım".
- **Commit hash'leri** `CommitLink` ile: `Session.repoUrl` varsa GitHub commit sayfasına bağlantı, yoksa düz metin.
- Pencereler: Escape yalnızca en üstteki pencereyi kapatır (`useEscape` yığını).
- Erişilebilirlik: tıklanan ama `<button>` olamayan her şey `Pressable`; etiketler `htmlFor`/`id` ile bağlı; jsx-a11y kuralları lint'te hata seviyesinde.
- Rolün izin vermediği düğmeler gizlenir (`useSession().can(perm)`); asıl denetim sunucuda.
