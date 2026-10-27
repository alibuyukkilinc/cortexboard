---
title: Web pano
summary: "React 19 + Vite. dist/web içine derlenir, `cortexboard start` sunar.
  Menü üç grup: Çalışma (Bildirimler, Pano, Tartışmalar, Onaylar), Hafıza
  (Bilgi, Eskimiş bilgi, Aktivite, Arşiv), Proje (Raporlar, Kurallar, Kılavuz).
  Türkçe/İngilizce, açık/koyu tema, filtreler URL'de, canlı güncellenir."
links:
  code:
    - file: web/src/App.tsx
    - file: web/src/api.ts
    - file: web/src/hub.tsx
    - file: web/src/filters.tsx
verified_at_commit: dd51582604a259736a2b098940fc3d7b6013a04b
id: 01M34Q1CBDWE3WNXKNMP6QK1W7
status: active
updated_by: ai-agent
updated_at: 2026-09-29T06:29:55.591Z
---

- Sayfalar: Bildirimler, Pano, Tartışmalar, Onaylar, Bilgi, Eskimiş bilgi, Aktivite, Arşiv, Raporlar, Kurallar, Kılavuz (+ merkezde Üyeler). Ayrıntı: `frontend/pages`; tasarım kuralları `frontend/design-system`; testler `frontend/quality`.
- **Menü grupları** (`NAV` + `NAV_GROUPS`, `web/src/App.tsx`): Çalışma = Bildirimler, Pano, Tartışmalar, Onaylar; Hafıza = Bilgi, Eskimiş bilgi, Aktivite, Arşiv; Proje = Raporlar (kısıtlı üyede yok), Kurallar, Üyeler (hub), Kılavuz. Kişinin ne için geldiğine göre sıralı (tasarım kararı `01M3AJ1SRRPTM51GFWVBVT78PS`). Yeni sayfa eklerken bir `group` verilir.
- Adres çubuğunda # ile gezinme (`#/knowledge/...`, `#/item/<id>` kalem çekmecesini **açıldığı sayfanın üstünde** açar ve kapanınca oraya döner (dışarıdan gelen bağlantıda Bildirimler; 44ead04), `#/discussions/<id>` bir tartışmayı açar); iskelet ve menü `web/src/App.tsx` içinde. **Filtreler ve dönem de adreste** (`#/board/issue?assignee=@ai`, `#/search?q=..&kind=item`, `#/activity?before=..`, `#/reports?week=..`): `useRouteQuery()` (`web/src/filters.tsx`) okur ve `replaceState` ile yazar. Kişiye özel kayıtlı görünümler bu adresleri saklar (`/api/views`).
- Oturumda iki tür listesi var: `itemTypes` panonun türleri (`discussion` hariç: tartışmaların kendi ekranı var), `allItemTypes` her şey (Kurallar sayfası bunu kullanır).
- Menü üst çubuktaki düğmeyle 56 px'lik ikon şeridine daralır (tarayıcıda hatırlanır); şeridin üstüne gelince ya da sekmeyle girince etiketler ve grup başlıkları görünür, tıklayınca şerit kenara çekilir. Bekleyen sayılar ikonda nokta olur. Telefonda menü tek yatay şerittir, grup başlıkları gizlenir. Tıklama/ayrılma izleyicileri JSX yerine dinleyici olarak bağlı.
- **Telefon (UI-12):** en dar genişlik 375 px; hiçbir ekran yana kaymaz ve dokunmatikte her kontrolün vuruş alanı 44 px (`frontend/design-system`, `e2e/mobile.spec.ts`).
- **Rozet sayıları tek istekten gelir:** kenar çubuğu `GET /api/counts` çağırır (`{ inbox, approvals, stale, discussions }`). Kenar çubuğu her sayfada duruyor ve her canlı olayda yenileniyor; bu yüzden oradan tam liste çekilmez. Kural: menüde yalnızca sayı gösteren bir şey eklenecekse `/counts`'a alan eklenir, yeni bir liste isteği açılmaz.
- Hangi ekran: `Root` önce `/api/health` ile tek proje mi hub mı öğrenir. Hub'da `/` projelerim, `/admin` organizasyon, `/p/<proje>/` pano, `/invite/<token>` şifre belirleme. `apiPath()` proje isteklerini `/api/p/<proje>/…` ucuna çevirir (ek dosya adresleri dahil).
- `useApi` (`web/src/api.ts`) sunucu bir değişiklik bildirdiğinde (`LiveContext`) veriyi yeniden çeker, `on: [...]` ile yalnız ilgili türde; yeni sayfa yüklenirken önceki veriyi ekranda tutar. İlk yüklemeyi sayfanın `PageGate`'ine bildirir (`LoadGateContext`): sayfa, ilk yüklemelerinin hepsi bitene kadar gizli bekler ve tek seferde bitmiş haliyle çıkar (60 ms birleştirme, 180 ms'den uzunsa tek yükleyici: ince çubuk + dönen gösterge, en fazla 8 sn; dd51582, görev 01M3NWY4D3T8TWF4N7GH41J6RV). Sebep: bölüm bölüm iskelet → içerik geçişi sayfayı parça parça getiriyor, alttakileri kaydırıyordu. `PageGate` `App.tsx`'te sayfa başına (`key` = sayfa + ilk parça) ve `HubFrame`'de (adres başına). Sayfa açıldıktan sonraki yüklemeler (çekmece, sonradan açılan paneller) kapıyı beklemez; kendi `Loading` iskeletleri görünür.
- Yazma isteklerinde `x-cortex-csrf: 1` başlığı gönderilir (çerezle giriş; tek projede çerez bir oturum anahtarıdır, API token'ı değil).
- Ekler `web/src/attachments.tsx`: yükleme ham gövdeyle (`?name=`), yapıştırma/bırakma kancaları, Markdown alanı, ek ızgarası ve önizleme.
- Geliştirme: `npm run dev:web` 5173 portunda açılır, /api ve /login isteklerini 4747'ye yönlendirir.
