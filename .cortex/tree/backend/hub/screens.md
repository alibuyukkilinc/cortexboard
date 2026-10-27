---
title: Hub ekranları ve rol yetkileri
summary: "Hub panelinde kim neyi nereden yapar: kişiler, AI ajanları, projeler,
  yedekleme, kullanım, bağlantı kılavuzu; hazır rollerin yetkileri
  (src/hub/roles.ts)."
links:
  code:
    - file: web/src/hub.tsx
    - file: src/hub/roles.ts
verified_at_commit: e62c847ba735c3eb43b9abc680fc13cf8c76646e
id: 01M3PN87GDTJ1D011E4E467NX0
status: active
updated_by: claude-code-new
updated_at: 2026-09-29T13:21:48.046Z
---

## Ekranlar (kim neyi nereden yapar)
- **Kişi ekleme:** Organizasyon → Kişiler → "Kişi ekle". Sistem 48 saatlik tek kullanımlık davet bağlantısı verir; "Yeni bağlantı" aynı zamanda şifre sıfırlamadır.
- **AI ajanı ekleme:** Organizasyon → AI ajanları → "AI ajanı ekle" ya da proje Üyeler sayfasında "Yeni AI ajanı". Token bir kez gösterilir; "Yeni token" eskisini geçersiz kılar. **Yeni ajanın varsayılan rolü Güvenilir** (karar `01M3MXD1644M8SBHHT2RHP8XDB`; pano, organizasyon sayfası ve API'de rol verilmezse). **Var olan** bir ajanı başka projeye eklemek (Üyeler sayfasının açılır listesi ya da `cortexboard hub member`) ise hâlâ Katkıcı (`DEFAULT_ROLE`): bağlı projede Okuyucu kalması gereken bir ajan yanlışlıkla yazma yetkisi almasın.
- **Proje ekleme:** Organizasyon → Projeler → "Proje ekle" ya da `cortexboard hub add-project <klasör>`.
- **Proje kod klasörü:** Organizasyon → Projeler → klasörün yanında "Değiştir" (aşağıda Yedekleme → Kod klasörü değiştirme).
- **Silme (954b118, görev 01M3NQWBCVKGB73PR5659TWX2S):** Organizasyon → Kişiler / AI ajanları → Sil (`DELETE /api/admin/users/:id`, `/api/admin/agents/:id`). Oturum, davet ve sohbet anahtarları yabancı anahtarla, üyelikler elle silinir; yazdıkları projelerde kalır. Kimlik `retired_ids` tablosuna girer ve `idTaken` onu da sayar: aynı ad bir daha verilmez (yoksa yeni biri eskinin geçmişini devralmış görünür). Kendini ve son organizasyon yöneticisini silemezsin.
- **Projeden ajan token'ı:** Üyeler sayfasında ajan satırında "Yeni token" (`POST /api/p/:project/agents/:id/token`), rehberle. Token ajanın bütün projelerinde geçerli olduğu için isteyenin ajanın **bütün** projelerinde `manage_members` yetkisi olmalı (ya da organizasyon yöneticisi); yoksa hangi projeler yüzünden olmadığını söyleyen 403. Önceden yalnız "bu projede mi" bakılıyordu: bir projenin sahibi paylaşılan bir ajanı devralabilirdi.
- **Proje bağlama:** Organizasyon → Projeler → "Bağlı projeler" sütunu → Bağla/Düzenle. Pencerede "bu projenin AI ajanlarını onlara Okuyucu olarak ekle" (varsayılan açık) bağlantıyla birlikte üyeliği de verir. Bkz. aşağıda "Bağlı projeler".
- **Ajanı bağlama rehberi:** AI ajanı oluşturulunca ya da token yenilenince pencere (`Secret` + `ConnectGuide`, `web/src/hub.tsx`) adım adım kurulum gösterir: Node sürümü, sisteme göre hazır komut (macOS/Linux `npx`, Windows cmd/PowerShell `cmd /c npx`, `.mcp.json`), `/mcp` ve `cortex_brief` ile kontrol, isteğe bağlı `--human-token`. Komutlarda hub adresi, proje ve token yerleşik; adres `/api/hub/me` → `hub_url` (`public_url`, yoksa `http://localhost:<port>`) ve pencerede düzenlenebilir. Kişi davet penceresi buraya yönlendirir. (Görev 01M3NP8XVMSKZKAM94VG14CN7B.) Eksik sırrı rehber kendisi üretir: sohbet anahtarım ya da ajana yeni token (d8fc77f); sohbet anahtarı penceresi de aynı hazır komutu verir (78f3677). Komutlar önce `claude mcp remove cortex` gerektiğini söyler.
- **Rehber proje seçilmeden komut vermez (32d893f):** birden çok proje varken rehber proje seçilene kadar komut ve sohbet anahtarı düğmesi göstermez. Önceden ilk projeyi sessizce seçiyordu: bir bağlantı yanlışlıkla `--project app-mobile` ile kuruldu. AI ajanları sekmesi rehberi ajanın projesiyle (varsa) açar.
- **Cortex'i Claude Code'dan kaldırma (32d893f):** AI ajanları sekmesinde "Cortex'i kaldır" bölümü: kopyalama düğmeli numaralı komutlar (`claude mcp list`, `claude mcp remove cortex`, `claude mcp remove cortex -s local`), `local` kayıtların project kaydını ezdiği notu ve token'ı durdurmak için panelde "Yeni token"/Sil.
- **Üyelik ve görünürlük:** Proje panosunda Üyeler sayfası: rol, "her şeyi / yalnızca kendi kayıtlarını", dal kısıtı. Terminalden aynısı: `cortexboard hub member <proje> <kim> [--role] [--scope] [--branches] [--remove]`.

## Rollerin yetkileri (`src/hub/roles.ts`)
- Sahip ve Yönetici: hepsi (read, ask, write_items, write_knowledge, delete_knowledge, approve, edit_rules, manage_members, reports, log_activity).
- Üye: read, ask, write_items, write_knowledge, approve, reports, log_activity.
- İzleyici: read, ask, reports.
- AI Okuyucu: read. AI Katkıcı: read, ask, write_items, write_knowledge (taslak olur), log_activity. AI Güvenilir: aynısı, bilgi yazımı doğrudan geçer.
- Hiçbir AI rolünde approve, edit_rules, manage_members yoktur. Ek dosya yüklemek write_items ister.
