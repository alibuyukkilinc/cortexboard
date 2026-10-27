---
title: MCP sunucusu
summary: "`cortexboard mcp` stdio üzerinden çekirdek 20 araç (`--tools full` ile
  27); kişi varsa 5 onay aracı. Hub'da HTTP ucu: POST /mcp/p/<proje>; ajan
  token'ı + `X-Cortex-Human-Token`, ya da OAuth (claude.ai bağlayıcısı: yalnız
  URL). Araçlar proje REST API'sini konuşur."
links:
  code:
    - file: src/hub/oauth.ts
    - file: src/hub/mcpHttp.ts
    - file: test/oauth.test.ts
verified_at_commit: 0457b0bc56e87c08b3f05d4c525198eadbdacedc
id: 01M34QY9T47QSX4Q0GQ8V6GPEH
status: active
updated_by: claude-code-new
updated_at: 2026-10-02T18:10:08.935Z
---

- **Araç seti** (commit 5269221): `tools/list` her oturumun başında modele gider. Varsayılan **core**: iş döngüsü ve sunucu talimatında ya da bir ipucunda adı geçen her araç. `FULL_ONLY` (`src/mcp/server.ts`) yalnızca `--tools full` ile gelir: `cortex_items`, `cortex_item_file`, `cortex_report`, `cortex_archive`, `cortex_discussions`, `cortex_close_vote`, `cortex_activity`.
  - Seçim yolları: CLI `mcp --tools core|full`, ortam `CORTEX_TOOLS`, hub HTTP ucunda `?tools=full`.
  - Ölçüm: tüm araçlar önce 28,1 KB (~7.000 token). Şimdi core 25 araç (onaylar ve `cortex_finish` dahil) 19,3 KB (~4.800 token). Ölçmek için: `node --import tsx scripts/measure-tools.ts core|full`.
  - Yeni araç eklerken: talimatta ya da bir cevabın ipucunda adı geçecekse core'da kalmalı. `test/interfaces.test.ts` talimatta adı geçen her aracın core'da olduğunu denetler.
- **`cortex_finish`** (commit f9dc48c, `src/mcp/finish.ts`): bir işi tek çağrıda bitirir: `POST /activity` (karar kontrolü dahil) → karta cevap + durum → claim bırakma (yalnız bu ajan tutuyorsa) → istenirse `PUT /status`. Durum doğrudan geçilemiyorsa türün geçişlerinden en kısa yol bulunur (`statusPath`; issue `open → in_progress → review`), ara adımlar düz taşıma, son adım cevapla birlikte. `commits`/`files`, türün yanıt alanlarını doldurur (issue `commits`/`files`, görev `evidence`). İlk başarısız adımda durur: `finished`, `steps`, `failed`, `left`. Her adım aynı REST yolundan: kurallar, rol ve taslaklar aynen.
- **`cortex_code_context`** (commit 71de131): varsayılan olarak yalnız açık kalemler ve kabul edilmiş kararlar; bitmiş, kapalı, karara bağlanmış, reddedilmiş ya da eskimiş olanlar `closed_items` sayısı olarak (çağıranın görünürlüğüne göre sayılır), `include_closed: true` ile liste. Kural kontrolü (`decisions_to_check`) etkilenmez.
- Araçlar (`src/mcp/server.ts`) doğrudan çekirdeği değil `McpApi`yi çağırır (`src/mcp/client.ts`):
  - `localApi(cortex, actor, { human? })`: bellek içi Fastify; `projectRoutes` aynen çalışır, ağ yok, token yok. `human` verilirse `api.human.as(via)` insan adına tek kullanımlık bir kanal açar; yalnız onay araçları kullanır (`backend/approval/chat`).
  - `remoteApi(hub, project, token)`: `<hub>/api/p/<proje>/…` uçlarına `Authorization: Bearer` ile gider. `withRemoteHuman(api, hub, project, chatKey)` (`--human-token`) kişiyi ekler: kişi adına istekler sohbet anahtarı + `x-cortex-via` ile gider.
  - `call(method, path, { query, body, text, binary })`: `binary` gövdeyi bayt olarak döndürür (ekler için).
- **HTTP ucu** (`src/hub/mcpHttp.ts`, hub'da `apiFor`): `POST /mcp/p/<proje>`, durumsuz; her istek için yeni sunucu ve taşıyıcı, çağrı `app.inject` ile aynı proje rotalarına gider. Hatalı ajan token'ları adres başına sınırlanır.
  - **Kişi** (commit e1455ef): isteğe bağlı `X-Cortex-Human-Token: <sohbet anahtarı>` (`HUMAN_KEY_HEADER`). Anahtar o projede bir kişinin olmalı; değilse 403. Varsa onay araçları sunulur; kişi adına çağrılar sohbet anahtarı + `x-cortex-via` ile gider (kapsam kuralı ve kişinin rolü aynen). Durumsuz HTTP istemciye soru gönderemez: onay soruları panoya düşer; araç 90 sn bekler, istemci keserse `cortex_pending_approvals` → `on_board`.
- Böylece tek kaynak var: REST'te düzelttiğin kural MCP'de de geçerli olur.
- Hatalar kod, mesaj ve ipucuyla döner (`setErrorHandler`); yetki reddi `hint.needs` ile eksik yetkiyi söyler.
- MCP yolunda asla `console.log` kullanılmaz: stdout protokole aittir (stderr kullan). `test/cli.test.ts` denetler.
- **Az çağrıyla okuma** (commit be7ccd7): `cortex_items(preview: true)` (full) satıra gövde özeti ve son cevabı ekler; `cortex_item(ids: [...])` en fazla 10 kalemi tek çağrıda okur.
- `cortex_item_file(id, name)` (full): ek metin (100.000 karaktere kadar) ya da güvenli resim (≤4 MB) olarak döner.
- **Tartışmalar** (`backend/discussions`): `cortex_discuss` (core), `cortex_discussions` ve `cortex_close_vote` (full).
- **Onaylar** (`backend/approval/chat`): `cortex_pending_approvals`, `cortex_ask_human`, `cortex_review_drafts`, `cortex_capture`, `cortex_record_human_answer`; yalnız kişi varken.
- `cortex_log_activity` cevabı, değişikliğin eskittiği düğümleri ve "bu turda kapat" ipucunu içerir (`backend/activity`).
- MCP sunucusu oturum başında açılır: araç kodu değişince oturum yeniden açılmalı (2026-09-29'da seçmeli soru denemesinde görüldü).
- Bağlantı kılavuzu (`web/src/hub.tsx` `ConnectGuide`): Claude Code, Codex, Cursor, Antigravity, opencode ve URL + başlık için hazır kurulum.
- Testler: `test/interfaces.test.ts`, `test/hub.test.ts` (core 20, full 27; HTTP'de sohbet anahtarı başlığı), `test/finish.test.ts`, `test/open-items.test.ts` (code context süzgeci), `test/protocol.test.ts`, `test/attachments.test.ts`, `test/open-queue.test.ts`, `test/discussions.test.ts`, `test/chat-approvals.test.ts`.
- **Bağlı projeler** (commit 8c9308d): okuma araçları isteğe bağlı `project` alır (ortak `LINKED` şeması). Salt okuma.

## OAuth ile bağlanma (claude.ai, Claude masaüstü)

claude.ai ve Claude masaüstü uygulamasının "Add custom connector" ekranı başlık (Authorization) alamaz, yalnız URL ve OAuth bekler. ChatGPT'nin Developer mode bağlayıcıları da aynı. Bu yüzden hub'da OAuth 2.1 sunucusu var (`src/hub/oauth.ts`, test: `test/oauth.test.ts`).

- **Akış:** token'sız `POST /mcp/p/<proje>` → 401 + `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp/p/<proje>"` → `/.well-known/oauth-authorization-server` → `POST /oauth/register` (dinamik istemci kaydı, açık; adres başına sınırlı) → `GET /oauth/authorize` (PKCE S256 zorunlu) → `POST /oauth/token` (`authorization_code`, `refresh_token`).
- **İzin sayfası** sunucuda üretilen HTML (Türkçe/İngilizce, `Accept-Language`). Kişi hub e-posta + şifresiyle girer (pano oturum çereziyle aynı), projeyi `resource` adresinden alır, **hangi AI ajanı olarak** çalışacağını seçer (projedeki ajanlar ya da yeni ajan; yeni ajan `trusted`, karar 01M3MXD1644M8SBHHT2RHP8XDB). Yalnız `manage_members` yetkisi olan (sahip, yönetici, org yöneticisi) bağlayabilir: bir uygulamaya ajan kimliği vermek, ajan token'ı vermekle aynı şey.
- **Token:** `oat_` erişim (1 saat), `ort_` yenileme (90 gün, her yenilemede ikisi de değişir). Yalnız özetleri `oauth_grants` tablosunda. Token o tek projede o ajandır; `x-cortex-via` başlığıyla kişinin sohbet anahtarı gibi davranır. Böylece onay araçları kişi adına sunulur (durumsuz HTTP: sorular panoya düşer).
- **İptal:** panoda profil menüsü → "AI sohbetinden onay" → "Bağlı AI uygulamaları" (`GET/DELETE /api/hub/connections`). Kişi veya ajan devre dışı kalınca, üyelik silinince token çalışmaz.
- **Pano:** bağlan rehberinin (`ConnectGuide`, token ve sohbet anahtarı popup'ları) en üstünde `AppConnect` bölümü: Claude / ChatGPT sekmeleri, adım adım kurulum ve projenin adresi (kopyala düğmesi). Altında "Komutla ya da ayar dosyasıyla" (Claude Code, Codex, Cursor…). Proje Kılavuzu sayfası (`guide.aiRemote`) da iki uygulamayı anar. Test: `web/test/connect.test.tsx`.
- **Kurulum özeti:** Claude → Customize → Connectors → Add → Add custom connector; URL `https://<hub>/mcp/p/<proje>`; Advanced boş; Connect → hub sayfası → İzin ver. ChatGPT (Plus ve üstü) → Settings → Apps & Connectors → Advanced settings → Developer mode → Create; MCP Server URL aynı adres, Authentication OAuth. Claude Code: `claude mcp add --transport http cortex <URL>`, sonra `/mcp` → Authenticate.
- Metadata adresleri `public_url`'den gelir: hub dışarıdan HTTPS ile erişilebilir ve `public_url` doğru olmalı (bağlantıyı Anthropic / OpenAI sunucuları kurar). Bu repoda hub bu bilgisayarda `node dist/cli.js hub start` ile çalışır (`start.cmd` 4), `<hub>` tüneliyle; pano dosyaları her istekte okunur (yalnız pano değişince build yeter), sunucu kodu değişince hub yeniden başlatılır.
