---
title: Güvenlik modeli
summary: "Tek proje: yalnızca localhost, sahibine özel token'lar (0600), 10
  dakikalık imzalı giriş bağlantısı, özetle saklanan iptal edilebilir pano
  oturumu. Ekler yalnızca güvenli türlerde satır içi. Hub: scrypt şifre,
  httpOnly oturum, CSRF başlığı, her kapıda deneme sınırı; rol ve görünürlük."
links:
  code:
    - file: src/api/auth.ts
    - file: src/api/server.ts
      lines: 113-206
    - file: src/api/sessions.ts
    - file: src/core/project.ts
    - file: src/hub/server.ts
    - file: src/hub/limiter.ts
    - file: src/hub/crypto.ts
    - file: src/store/attachments.ts
    - file: src/backup/routes.ts
verified_at_commit: 0457b0bc56e87c08b3f05d4c525198eadbdacedc
id: 01M34Q1CBF3AXG1Q0MKDJYKB6J
status: active
updated_by: claude-code-new
updated_at: 2026-10-03T19:25:01.594Z
---

- `onRequest` kancası localhost/127.0.0.1/[::1] dışındaki her Host'u reddeder.
- Giriş kodu `<aktör>.<bitiş>.<imza>` aktörün kendi token'ıyla imzalanır: sunucuda durum tutmaz, token hiçbir zaman adres çubuğuna veya geçmişe düşmez.
- Pano oturumu (`src/api/sessions.ts`): `/login` rastgele bir oturum anahtarı verir; çerez API token'ı DEĞİLDİR. `.cortex/.sessions.json` yalnızca SHA-256 özetini tutar, 30 gün geçerli, 0600, git'e girmez. `/api/logout` oturumu siler; `cortexboard logout [--actor] [--all]` çalışan sunucudaki oturumları da bitirir.
- Geçiş: ham token taşıyan eski çerez bir kez kabul edilip yeni oturumla değiştirilir (aynı anda gelen istekler aynı oturumu alır); yalnızca insan aktörler. 0.2.x sonrası kaldırılacak.
- Bearer yolu (AI'lar, betikler) değişmedi. `loadTokens` değişim zamanı+boyutla önbellekler; karşılaştırma SHA-256 özetleri üzerinde `timingSafeEqual` ile, erken çıkmadan tüm girdilere bakar.
- `.secrets.yaml` `init`'te 0600 yazılır; POSIX'te daha gevşek izinli eski dosya ilk okumada 0600'a çekilir.
- Çerezle yapılan yazımlar `x-cortex-csrf: 1` başlığı ister; CORS hiç açılmaz.
- **Pano oturumu işareti** (commit 662e636): çerezle giriş yapan istekte `req.boardSession = true` (yerelde `buildServer`, hub'da oturum çerezi yolu). Token, sohbet anahtarı ve MCP'nin insan kanalı (`localApi` grant'ı, `x-cortex-via`) bu işareti taşımaz. Panoda sorulan sorunun cevabı (`POST /chat/prompts/:id/answer`) yalnız bu işaretle ve etkin `via` yokken kabul edilir (`board_only`): AI'ın çalıştığı süreçte duran hiçbir kimlik bilgisi soruyu cevaplayamaz. Hub'da sohbet anahtarı bu uca zaten kapsam dışı (`chat_key_scope`). Ayrıntı: `backend/approval/chat`.
- Aktör adları dosya adı olarak kullanıldığı için denetlenir.
- **Ekler** (`GET /items/:id/files/:name`): tür uzantıdan belirlenir, `X-Content-Type-Options: nosniff` ve `Content-Security-Policy: sandbox; default-src 'none'` ile sunulur. Yalnızca güvenli resimler (png/jpeg/gif/webp/avif/bmp/ico) ve metin satır içi; SVG, HTML ve PDF her zaman indirme (sayfada kod çalıştırabilirler). Dosya adı tek bir güvenli yol parçasına çevrilir; zaten güvenli olmayan ad (`../item.md`, ters bölü) hiç çözülmez, 404. Dosya başına 15 MB, kalem başına 100. Panoda Markdown DOMPurify'dan geçer; `blob:` adreslerine yalnızca henüz yüklenmemiş ekleri gösterirken izin verilir.
## Hub
- Şifreler scrypt ile özetlenir, en az 10 karakter; davet ve oturum tokenları yalnızca SHA-256 özetiyle saklanır. Davet 48 saat geçerli, tek kullanımlık.
- Oturum çerezi httpOnly, SameSite=Lax. Secure: `hub.yaml` → `cookie_secure` verilmişse o; verilmemişse hub yalnızca loopback'te dinlemiyorsa açık. `trust_proxy: true` iken `X-Forwarded-Proto: https` de Secure yapar. Çerezle yazımlar `x-cortex-csrf` ister.
- Deneme sınırı (`src/hub/limiter.ts`, 15 dakika): adres+e-posta başına 10 hatalı şifre; adres başına 10 hatalı ajan token'ı (REST ve MCP birlikte); adres başına 20 geçersiz davet bağlantısı. Bellek üst sınırlı.
- `allowed_hosts` tanımlıysa listenin kendisidir: localhost için gizli istisna yok.
- İnternete açılacaksa HTTPS arkasında çalıştırılmalı; `hub start` ağa açıkken HTTPS yoksa uyarır.
- **Güven sınırı — hub'ın dosyaları:** `~/.cortex/hub` klasörünü okuyabilen kişi zaten şifre özetlerini ve token özetlerini görür, yani hub'ın sahibidir. `cortexboard hub member <proje> <kim>` bu yüzden ayrı bir yetki istemez: üyelik verme API'de insanlara ayrılmıştır (hiçbir AI rolü `manage_members` taşımaz), terminaldeki komut ise makinenin sahibinin elindedir. Uzaktan bağlanan bir ajan bu komutu çalıştıramaz; yalnızca dosyalara erişen çalıştırabilir.
- Üyeliği olmayan bir istek 403 alır ve mesaj iki tarafı da yazar (`opencode is not a member of "app-api"`), çünkü bir ajanın hatası çoğu zaman başka birinin günlüğünde okunur. Geçerli token + eksik üyelik ile geçersiz token birbirine karışmasın diye ayrı kodlar: `unauthorized` ve `forbidden`.
- Güvenlik bildirimi: `SECURITY.md` (GitHub özel açık bildirimi).
- **Güvenlik başlıkları (c690fed):** `baseServer` her cevaba ekler (yerel pano ve hub): `Content-Security-Policy` (`CONTENT_SECURITY_POLICY`, `src/api/server.ts`: `script-src 'self'`, `style-src 'self' 'unsafe-inline'` çünkü React style prop'ları, `img-src` https dahil çünkü bilgi markdown'ındaki görseller, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Permissions-Policy` (mikrofon yalnız kendi adresine: sesle yazma), https'te `Strict-Transport-Security`. Kendi CSP'sini koyan cevap onu korur (ekler: `sandbox`). Satır içi betik yok: tema betiği `web/public/theme.js`. Test: `test/security-headers.test.ts`.
- **Hub adresi ortamdan:** `CORTEX_PUBLIC_URL`, `CORTEX_TRUST_PROXY`, `CORTEX_ALLOWED_HOSTS` `hub.yaml`'ın yerine geçer, dosyaya yazılmaz (`settingsFromEnv`, `src/hub/store.ts`). Tünel arkasında `trust_proxy` olmazsa bütün istemciler 127.0.0.1 görünür ve deneme sınırları paylaşılır: 10 kötü token bütün ajanları 15 dakika kilitler. `allowed_hosts` büyük/küçük harfe duyarsız.
- **Silinen kimlikler** `retired_ids`'e girer, bir daha verilmez; projeden ajan token'ı yenilemek ajanın bütün projelerinde `manage_members` ister (`backend/hub`).
- **Yedekler** (`backend/hub` → Yedekleme): her zaman şifreli (AES-256-GCM), anahtar yedekte değil. Depolama anahtarları, Google istemci sırrı ve yenileme token'ı `backup.secrets.yaml`'da (0600, git dışı), hiçbir uç geri vermez; Google cihaz kodu sunucuda bekler. Google izni yalnız `drive.file` (Cortex'in kendi dosyaları). Hub'da yedek uçları ve `POST /api/admin/restart` yalnız organizasyon yöneticisi; tek projede `/api/backup` yalnız insan aktör (AI token'ı 403). İndirme adı arşiv desenine uymalı (yol içeremez). Geri yüklenen arşiv hedef klasörün dışına yazamaz (`writeEntries`).
- 2026-09-29 güvenlik taraması ve açık maddeleri: görev 01M3NR0PMHXV0X2PRCHNJAQWV8.
- Henüz yok: SSO, iki adımlı doğrulama, e-postayla davet gönderimi.
