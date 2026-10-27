---
title: Kalemler, şemalar ve kurallar
summary: "Altı hazır tür: görev, issue, soru, not, karar, tartışma; her biri
  rules/<tür>.schema.yaml ile tanımlı. \"Bitti\" iki şey: terminal ve resolved.
  Görev/issue'yu AI cevapla bitirir (reply_required). Soru seçenek taşıyabilir.
  claim ve if_rev eşzamanlı yazımı korur."
links:
  code:
    - file: src/api/routes.ts
      symbol: resolveItemId
    - file: src/util/text.ts
      symbol: shortIdSuffix
    - file: web/src/ui.tsx
      symbol: ShortId
verified_at_commit: b2e1e77b4b1cdcb08660554515a5676432478b40
id: 01M34QY9EQ1V2FK6QYKKVTPEDB
status: active
updated_by: claude-code-new
updated_at: 2026-10-01T07:24:51.295Z
---

- Varsayılanlar `DEFAULT_SCHEMAS` içinde (`src/core/schema.ts`); `init` bunları `.cortex/rules/` altına yazar. Dosyası olmayan eski projeler yerleşik varsayılanı kullanır (yeni `discussion` türü de böyle gelir).
- **Sonradan eklenen alanlar** (`ADDED_FIELDS`, `parseSchema`): şema dosyası o alandan önce yazılmış projelerde alan yüklenirken eklenir, dosyaya dokunulmaz (kural dosyaları insanındır). Şu an: görev ve issue'da `milestone`, soruda `options`. Dosyada aynı ad varsa dosyanınki geçerli.
- Bir şemada şunlar var: durumlar, başlangıç ve bitiş durumları, izinli geçişler, yalnızca insanın koyabileceği durumlar, alanlar, yanıt kuralları, kapanışta cevap kuralı (`reply_required`) ve AI'a düz dille talimatlar.
- Yeni tür eklemek için `rules/<tür>.schema.yaml` dosyası bırakmak yeter.
- Kuralları yalnızca insan değiştirebilir; kaydetmeden önce denetlenir (`validateRulesDoc`), bir yazım hatası tüm yazımları bozamaz.
- `rules/_global.yaml` içindeki `language` alanı AI'ların hangi dilde yazacağını belirler; brief'te ilk kural olarak görünür.
- `rules_version` = rules/ klasörünün özeti. Her cevapta `_meta` içinde gelir; AI kuralları yalnızca bu değişince yeniden okur.
- Kalem kime atanabilir: bir aktör, `@humans` (insanlar) ya da `@ai`. Gelen kutusunda engelleyici sorular en üstte (`ItemService.inbox`); hub'da görünürlük sorgunun içinde uygulanır, `count` üyenin açabildiği sayıdır. Gelen kutusu nedenleri: `review_waiting_on_you` (türüne bakmadan `review` durumundaki her açık kalem, son cevabı kişinin kendisi değilse), `assigned_to_you`, `assigned_to_group`, `your_question_answered`, `new_reply`, `decision_needs_review`, `discussion_needs_your_view`.
- `ask(about, title)` soruyu, sorulan şeyi yapan kişiye yönlendirir.
- Liste cevabı (`list`, pano kartı) kalemin özetini taşır: yanıt sayısı, ek sayısı (`files`), kapak resmi (`cover`), öncelik ya da önem (`level`), son tarih (`due`), açıklaması var mı (`has_body`). Hepsi indeksten gelir.

### Seçmeli soru (`fields.options`, commit 12c334b)
- Soru isteğe bağlı `options` taşır: 2-8 farklı cevap (tartışmanın `checkFields` kuralı; boş liste = serbest cevap). `create` ve `options` değişen `update`'te denetlenir.
- Sohbette ve panoda (`cortex_ask_human` kind `question`) seçenekler seçim olarak sorulur, altında isteğe bağlı not; yanıt gövdesi `seçenek` + boş satır + not (`answersFor`). Seçeneksiz soru eskisi gibi serbest metin.
- Pano: kart çekmecesinde açık sorunun yanıt kutusu üstünde seçenek düğmeleri; tıklamak seçeneği yanıtın ilk satırına koyar (önceki seçimi değiştirir, altındaki notu korur), göndermez. Pano sorusunda uzun ya da 3'ten fazla seçenek alt alta listelenir.

### Kapanışta cevap zorunlu (`reply_required`)
- Neden: AI işi `update_item(status=review, reason=...)` + devir notu + activity ile "bitiriyordu"; bunların hiçbiri kartta görünmüyor, kartı açan insan ne yapıldığını göremiyordu.
- Şema: `reply_required: { statuses, default }`. Yerleşik: görev `[review, done]`, issue `[review, closed]`, ikisinde de `default: true`. Soru, not, karar, tartışmada yok (sorunun cevabı zaten yanıt; karar ve tartışmanın kendi akışı var). Şema dosyasında anahtar yoksa `loadSchema` yerleşik kurala düşer. `validateRulesDoc` durumların geçerliliğini ve `default`'un boolean olduğunu denetler; `statuses: []` kuralı kapatır.
- Kalem: `Item.reply_required` bayrağı. Oluştururken verilmezse türün varsayılanıyla dolar; bayrağı olmayan eski kalemler türün varsayılanını izler (`needsReply(schema, flag, to)`).
- Zorlama `ItemService.update` içinde: aktör AI ise ve bayrak açıkken bu durumlardan birine geçiyorsa `reply_required` (400) hatası; ipucu `cortex_reply(..., status)` yolunu gösterir. Cevap + durum tek adımda `reply` ile geçer ve kartta görünür.
- İnsan panodan taşırken zorlanmaz (kararı veren o). Bayrağı oluşturduktan sonra yalnız insan değiştirebilir; AI kendi yükünü kaldıramasın diye `update` ile değiştirmesi 403.
- Pano: yeni kayıt penceresinde ve kart çekmecesinde "Kapanışta cevap zorunlu" kutusu (yalnız kuralı olan türlerde); çekmecede insan değiştirebilir.

### Türe özel kancalar: tartışma (`backend/discussions`)
- `ItemService` `discussion` türünde `src/core/discussions.ts`'e danışır: oluştururken ve seçenek değişince `checkFields` (2+ farklı seçenek), yanıtta `checkReply` (aşama, katılımcı ve `stance` kuralları).
- `voted` ve `decided` durumlarına yalnızca servis geçirir: `update(actor, id, input, { internal: true })`. Düz bir durum değişikliği `invalid_transition` alır.
- Bir `decision` `accepted` olunca `DiscussionService.onDecisionAccepted` onu doğuran tartışmayı `decided` yapar.
- `get(id, { viewer })`: okuyan verilirse kör turdaki görüşler süzülür ve cevap `discussion` özeti taşır. İçeriden yapılan okumalar `viewer` vermez, her şeyi görür.

### "Bitti"nin iki anlamı: terminal ve resolved (`src/core/schema.ts`)
- `terminal`: bu durumdan çıkan geçiş yok. Geçiş kontrolünü ve raporlardaki "kapanan kayıt" sayımını bu belirler.
- `resolved` (isteğe bağlı): iş bitti ama kalem hâlâ hareket edebilir. Karar türü için varsayılanı `[accepted]`.
- `isOpenWork(schema, status)` = ne terminal ne resolved. Açık iş soran her yer bunu kullanır: brief'teki dal sayıları, gelen kutusu, `items?open=true`, raporlardaki açık issue'lar.
- İndekste iki bayrak birden tutulur (`terminal`, `open_work`); ikisi de kurallardan gelir, bir kural değişikliği `retermItems` ile yeniden karar verir. Tek karar noktası `Cortex.itemFlags`.
- Şema dosyasında `resolved` yoksa `loadSchema` yerleşik varsayılana düşer: eski projeler güncellemeyle düzelir.
- `codeContext` bilerek istisna yapar: kabul edilmiş kararları da döndürür.

### Görev devri: claim/release, eşzamanlılık, devir notu (`src/core/items.ts`)
- `assignee` (kime ait) ile `claimed_by`/`claimed_at` (şu an fiilen kim çalışıyor) ayrı kavramlar.
- `ItemService.claim(actor, id, { action: "claim"|"release", note?, force? })`: atomik; boşsa, aynı aktördeyse veya süresi geçmişse (2 saat, `CLAIM_TTL_MS`) başarılı; başkası tutuyorsa 409 `conflict`. Yalnızca insan `force: true` ile devralabilir.
- Claim/release her zaman direkt yazar (taslağa düşmez) ve `itemRevision()`'ı değiştirmez; bekleyen bir taslağın `base_rev`'i etkilenmez.
- `handoff_note`: claim/release ile yazılan kısa (≤500 karakter) "nereye kadar geldim" notu. Kartta cevap yerine geçmez.
- `UpdateItemInput.if_rev`: verilirse `itemRevision(current)` ile karşılaştırılır, uyuşmazsa 409. `ItemService.get()` `rev` döndürür.

### Hatalar ve brief'teki zorunlu alanlar
- `invalid_item` ipucu: `issues` (satır metni, ajanlar okur) + `errors: [{path, message}]` (`fieldError`; alan adı `fields.<ad>` yoluna çevrilir, yolsuz satırın `path`'i boş).
- Brief `rules.item_types`: `tür(zorunlu,...)` biçimi (`itemTypeRequirements`): `category_path` dal zorunluysa, diğerleri `fields.` öneki olmadan. Koşullu kurallar (`require_when`) yalnız `cortex_rules(type)`'ta.
- Liste satırında `done: true` = türün kurallarına göre bitmiş (terminal ya da resolved); pano "son durum" tahmini yapmaz.

### Sürümler ve gövde koruması (`ItemStore.addVersion`, `ItemService.history/restore`)
- İçerik (başlık, gövde, atanan, dal, alanlar, bağlantılar, etiketler, `handoff_note`) değişen her yazımda önceki hal `items/<ULID>-<slug>/history/<ULID>.md` olur; en yeni 20 kalır. Yalnız durum değişikliği sürüm değildir. Sürüm kimliği `ulid()` (şimdiki zaman, monoton): değişikliğin zamanından üretmek sırayı bozuyordu.
- `restore(actor, id, version)`: içeriği geri getirir, durum ve claim aynı kalır; şimdiki hal sürüm olur. Politika `review` ise AI'ınki taslak.
- `UpdateItemInput.body_mode: "append"` gövdenin sonuna ekler. AI, 200+ karakterlik gövdeyi yarısının altına indirirse `409 body_shrink`; `confirm_shrink: true` ile geçer. İnsan engellenmez (pano sorar).

### Ekler (`ItemService.attach/detach`, `src/store/attachments.ts`)
- Dosyalar kalemin klasöründe: `items/<ULID>-<slug>/files/<ad>`. Klasör doğrunun kendisi. `get()` cevabı `attachments` listesini (ad, boyut, tür, eklenme zamanı) taşır; `itemRevision`'a girmez.
- Ad güvenli tek bir yol parçasına çevrilir ama okunur kalır; aynı ad tekrar gelirse `-2`. Dosya başına 15 MB, kalem başına 100, boş dosya reddedilir. Her ekleme/kaldırma `item.attached` / `item.detached` denetim kaydı bırakır.
- Politika: ekler taslak olamaz. AI'ın bu türe yazımları taslak olacaksa (review) ek yükleyemez/kaldıramaz; `human_only` zaten reddedilir; `auto`'da doğrudan. İnsan her zaman.
- Markdown'da `files/<ad>` aynı kalemin ekini gösterir; pano yapıştırılan ekran görüntüsünü `![..](<files/..>)` olarak ekler.

## Kısa kimlik

Panoda her kartta ve kalem çekmecesinde `#ZKFBA9` gibi bir kısa kimlik görünür: ULID'in son 6 karakteri. Tıklanınca kopyalanır. Dosyaya yazılmaz, ID'den türetilir.

REST'teki tek bir preHandler (`src/api/routes.ts`, `resolveItemId`) kısa kimliği tam ULID'e çevirir. Kapsadığı yerler: `/items/:id` ve `/discussions/:id` parametresi, `?ref=`, gövdedeki `refs`, `ref` ve `decisions[].id`. MCP araçları REST'i çağırdığı için onlar da kısa kimliği kabul eder; kişi AI'a "ZKFBA9'u yap" diyebilir.

- `#` öneki, harf büyüklüğü ve Crockford'un benzer harfleri önemsizdir: I ve L 1, O 0 okunur. En az 4 karakter gerekir.
- Kısa kimlik birden çok karta denk gelirse istek 409 `ambiguous_id` ile reddedilir ve `hint.candidates` adayları listeler. Tahmin yapılmaz; daha uzun bir son ek ya da tam kimlik verilir.
- Hiçbir karta denk gelmezse istek her zamanki 404'ü döner.
- `refs` içinde yalnızca `#` ile başlayan ya da büyük harfli kodlar kısa kimlik sayılır. Küçük harfli bilgi yolları dokunulmadan kalır.
