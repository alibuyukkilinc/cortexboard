---
title: Sohbet içinden insan onayı (MCP elicitation) ve pano sorusu
summary: Taslak, karar, @humans sorusu ve human_only geçiş AI sohbetinde
  sorulur; soru kayıttan kurulur, cevap elicitation ile gelir, insan adına `via`
  ile yazılır. İstemci gösteremezse aynı soru panoda popup olur (board-prompt),
  cevap yalnız kişinin pano oturumundan.
links:
  code:
    - file: src/mcp/approvals.ts
    - file: src/core/chat.ts
    - file: src/core/chatPrompts.ts
    - file: src/core/chatApprovals.ts
    - file: src/core/provenance.ts
    - file: src/mcp/client.ts
    - file: src/hub/server.ts
    - file: web/src/BoardPrompts.tsx
    - file: test/chat-approvals.test.ts
    - file: test/chat-hub.test.ts
    - file: test/board-prompts.test.ts
verified_at_commit: "662e636"
id: 01M3MR4D4643ET5E4Y7JZFQ9T8
status: active
updated_by: claude-code-new
updated_at: 2026-09-29T11:48:01.272Z
---

**Temel ilke:** AI insan onayı üretemez. Soruyu Cortex kurar, cevap istemcinin kendi arayüzünden (MCP `elicitation/create`, form modu) ya da kişinin kendi pano oturumundan gelir ve modelden geçmez. İnsan adına yazma yalnızca bu iki yoldan, aktarılan cevaptan ve panodaki onaydan yapılır.

**MCP araçları** (`src/mcp/approvals.ts`; yalnızca `api.human` varken kaydedilir):
- `cortex_pending_approvals`: `GET /approvals/chat` sonucunu verir: `draft`, `decision` (proposed), `question` (open, @humans ya da bir insana atanmış), `transition` (review'da ya da her ileri adımı human_only olan kalem). Ayrıca `settings`, `elicitation`, `human` ve bu AI'ın panoda sorduğu sorular (`on_board`: açık olanlar ve son 24 saatte cevaplananlar).
- `cortex_ask_human({kind, target_id|ids, to?, context?})` ya da `({prompt_id})`:
  - Soru metni kayıttan kurulur (diff, karar metni, kart). Geçişte kartın planı ve "plan kontrolü" hatırlatması da gösterilir. `prepare()` her soru için metni, formu, gereken yetkiyi ve **planı** (`PromptPlan`: cevap neyi değiştirir) üretir.
  - Sormadan önce kişinin rolü kontrol edilir (`GET /me` perms); yetkisi yoksa `not_permitted` döner ve soru hiç sorulmaz (panoda da).
  - Formdan cevaba çeviri çekirdekte: `answersFor(plan, content)` (`src/core/chatPrompts.ts`). Sohbet ve pano aynı formu aynı şekilde okur. Sohbette cevap `POST /chat/apply` ile kişi adına uygulanır.
  - Yavaş gelen `decline`/`cancel`: hiçbir şey değişmez, "cevap yok" aktivitesi yazılır.
- `cortex_review_drafts`: en eski taslaklardan `max_batch` kadarı, her biri için approve/reject/skip.
- `cortex_capture`: note, decision ya da node kaydeder; kişi adına, doğrudan aktif; decision hemen `accepted`.
- `cortex_record_human_answer`: kişi sorunun yerine sohbette kendi sözleriyle cevap verdiyse. `chat.relayed` ayarına göre: `accept` (uygulanır, `via.unverified`), `pending` (`POST /chat/relayed` kuyruğu), `off` (ret). `decision` ve `transition` için `relayed_human_only` gerekir.
- Zaman aşımı: `ELICIT_TIMEOUT_MS` 10 dk.

**Pano sorusu** (karar 01M3PCTFYV4WPM0APNNJJ9YJQG, commit 662e636): istemci soruyu gösteremediğinde aynı soru panoda sorulur. Ne zaman: istemci elicitation bildirmiyor, `--no-elicitation`, **1,5 sn'den hızlı red** (`AUTO_DECLINE_MS`; Claude masaüstü Code sekmesi, Codex böyle yapıyor; `suspected_auto_decline: true` ile döner), ya da istemci hiç cevap vermiyor (`elicitation_failed` artık panoya düşer). Aynı oturumda iki hızlı red olursa oturum istemciden sormayı bırakır (`AUTO_DECLINES_TO_STOP`).
- **Çekirdek** (`PromptService`, `src/core/chatPrompts.ts`, `cortex.prompts`): soru `.cortex/.prompts/<id>.json` (git'e girmez, yedeğe girmez, izleyici yok sayar; eski projelerde `.gitignore` satırı ilk soruda eklenir). Alanlar: `ai_actor`, `human`, `session`, `title`, `message` (gösterilen metin, en çok 12.000 karakter), `schema`, `plan`, `perm`, `shown_hash`, `status` (`open|answered|expired`), `expires_at`, cevapta `answer`, `result`. 24 saat geçerli (`PROMPT_TTL_MS`, sahip seçimi); kapanmışlar bir hafta sonra silinir. AI başına en çok 5 açık soru (`too_many_questions`, 429). Açılış ve cevap aktiviteye düşer (`chat.prompt`, `chat.prompt_answered`, kartın akışında).
- `answer(human, id, content)`: sorulan kişi mi, açık mı, form izin veriyor mu (enum değerleri, zorunlu alanlar, 4.000 karakter) bakar; sonra `provenance.run({channel: "board-prompt", ai_actor, session, shown_hash})` içinde `chat.apply` ya da capture ile kişi adına uygular. AI beklemeyi bırakmış olsa da geçerli.
- **REST** (`src/api/routes.ts`): `POST /chat/prompts` (AI, `ask` yetkisi; `perm` sunucuda plandan hesaplanır), `GET /chat/prompts` (insan: kendi açık soruları; AI: kendi sordukları; `?status=all`), `GET /chat/prompts/:id` (soran AI ya da sorulan kişi), `POST /chat/prompts/:id/answer`: yalnız `req.boardSession` (çerezle pano oturumu) ve etkin `via` yokken; token, sohbet anahtarı ve MCP'nin insan kanalı `board_only` alır (`security`). Hub'da sohbet anahtarı bu uca zaten kapsam dışı.
- **MCP**: soruyu açar, `BOARD_WAIT_MS` (90 sn, sahip seçimi) boyunca saniyede bir bakar. Cevap gelirse `{answered, recorded_as: {via: "board-prompt"}, result, prompt_id}`; gelmezse `{pending, prompt_id, expires_at}` ve "sessizliği evet ya da hayır sayma" ipucu. **Dikkat:** MCP SDK istemcisinin varsayılan istek zaman aşımı 60 sn; böyle bir istemci çağrıyı keserse `prompt_id`'yi `cortex_pending_approvals` → `on_board`'dan bulur.
- **Pano** (`web/src/BoardPrompts.tsx`, `Shell` içinde): kişinin açık soruları canlı gelir (`chat` olayı), tek tek `Modal` olarak çıkar; metin olduğu gibi, form şemadan (enum → seçim düğmeleri, metin → textarea). Seçmek göndermez, "Cevabı gönder" ayrı; kapatmak "Sonra". Ertelenenler için alt ortada "Bekleyen AI sorusu: n" düğmesi; Onaylar sayfasında "AI ajanlarının soruları" listesi (Cevapla). Sekme arka plandaysa izinle tarayıcı bildirimi. `ViaChip` "panoda soruldu" gösterir.

**Çekirdek** (`src/core/chat.ts` `ChatService`, dosyaları `.cortex/chat/` altında ve git'te):
- `apply(human, answer)`: taslak onayı veya reddi, kararın kabulü veya reddi (cevap olarak), soru cevabı, geçiş. Yetki kontrolü route'ta yapılır (`ANSWER_PERM`: draft→approve, question→ask, decision/transition→write_items; capture için write_items / write_knowledge).
- Aktarılan cevap kuyruğu `chat/relayed/<id>.json`. `confirm` panoda kişi tarafından yapılır ve `via.confirmed_by` yazar. `discard` kişi ya da cevabı aktaran AI.
- Geri alma: `via` taşıyan bir yazımda `remember` önceki hâli `chat/undo/<kayıt>.json` dosyasına saklar (düğüm onayı, sohbetten yakalanan düğüm, taslak reddi). `undo(human, kayıtId)` düğümü eski hâline getirir ya da siler, reddedilmiş taslağı geri getirir, `item.replied` durum değişikliğini force ile geri alır. Geri alınan kayıt `chat/undone/<kayıt>.json` ile işaretlenir (`already_undone`). Pano sorusuyla verilen cevaplar da `via` taşıdığı için geri alınabilir.
- `queryActivity({chat})`, `json_extract(json,'$.via')` üzerinden süzer (üç kanal da).

**Kanıt** (`src/core/provenance.ts`, AsyncLocalStorage): `via.channel` `chat-elicitation | chat-relayed | board-prompt`; ayrıca `ai_actor`, `session`, `shown_hash`, `verbatim`, `unverified`, `confirmed_by`. Yerelde `localApi` isteği `provenance.run` içinde tek kullanımlık bir grant ile çalıştırır; hub'da `onRequest` kancası `provenance.run(req.chatVia, done)`.

**Hub** (`src/hub/server.ts`, `store.ts` `chat_tokens`):
- Kişi panodan proje başına sohbet anahtarı oluşturur (`chat_` önekli); yalnız panoya giriş yapmış kişi yönetir.
- Sohbet anahtarı: yalnız kendi projesi; GET istekleri ile `POST /chat/apply`, `POST /items`, `POST /items/:id/replies`, `PUT /node/*` (gerisi `chat_key_scope`); `x-cortex-via` zorunlu (`via_required`); kişinin kendi üyeliği ve rolüyle.
- CLI: `mcp --hub … --token <ajan> --human-token <anahtar>` (`withRemoteHuman`). HTTP üzerinden MCP (durumsuz) elicitation taşıyamaz; orada da pano sorusu çalışır, ama insan (`api.human`) yoksa onay araçları hiç sunulmaz.

**Pano:** `ViaChip` "AI sohbetinden" (aktarılan onaylanmamışta "· doğrulanmadı", onaylanmışta "· onaylandı") ya da "panoda soruldu". Aktivite sayfasında "AI sohbetinde cevaplananlar" filtresi ve "Geri al". Onaylar sayfasında AI soruları ve "AI sohbetinden aktarılanlar" kuyruğu. Hub avatar menüsünde "AI sohbetinden onay".

**Plan kontrolü** (7. tur dersi): AI gövdesi dolu bir kalemi review'a (ya da human_only veya terminal bir duruma) taşırken `plan_check` ipucu gelir.

**Config:** `chat: { relayed, max_batch (10), relayed_human_only (false) }`. `relayed` varsayılanı yerelde `accept`, hub'da `pending` (sahip, 2026-09-28).

**Testler:**
- `test/chat-approvals.test.ts` (14): accept/decline/cancel, injection, karar, soru, geçiş, capture, relayed ayarı, sınır, geri alma, kuyruk, plan kontrolü, zaman aşımı → pano, `--no-elicitation` → pano, hızlı red → pano, pano cevabı `board-prompt` olarak, AI beklemeyi bıraktıktan sonra cevap ve `prompt_id` ile okuma.
- `test/board-prompts.test.ts`: yalnız pano oturumu cevaplar (AI token'ı, kişinin token'ı reddedilir), form doğrulama, ikinci cevap 409, süre dolumu, 5 soru sınırı, `.gitignore`, capture.
- `test/chat-hub.test.ts`: sohbet anahtarı kapsamı; hub'da pano sorusunu sohbet anahtarı cevaplayamaz, başka üye 404, pano oturumu cevaplar.
- `web/test/prompts.test.tsx`: seçmek göndermez, "Sonra" hayır değildir, düğmeyle geri açılır.

**Açık kalan:** 9. tur benchmark (bir hafta sohbet içi onayla çalıştıktan sonra).
