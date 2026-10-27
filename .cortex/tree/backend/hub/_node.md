---
title: Ekip sunucusu (hub)
summary: "Tek sunucu, çok proje: kişiler e-posta + şifreyle, AI ajanları token
  ile girer; proje başına rol ve görünürlük. Yeni projelerin bilgisi hub
  klasöründe (commit, push yok); kod kopyası yalnızca pull edilir. Bağlı
  projeler salt okunur. Şifreli yedek Bunny/Google Drive, panelden geri
  yükleme."
id: 01M34ZBMQDA04RDK228RSTYEHP
status: active
updated_by: claude-code-new
updated_at: 2026-09-29T13:21:48.626Z
---

## Parçalar (`src/hub`)
- `store.ts`: SQLite (`hub.db`) + `hub.yaml` ayarları (`org`, `public_url`, `host`, `port`, `allowed_hosts`, `cookie_secure`, `trust_proxy`, `pull_minutes`, `commit_seconds`, `backup`). Tablolar: users (scrypt şifre özeti), sessions, invites, agents (token özeti), projects (kod klasörü yolu), members (proje, kişi/ajan, rol, scope, branches), usage. Kimlikler (`ali`, `claude-code`) kişi ve ajanlar arasında benzersiz, çünkü projelerin dosyalarında aktör adı olarak görünürler.
- `crypto.ts`: scrypt (N=16384), tokenlar rastgele 32 bayt ve yalnızca SHA-256 özeti saklanır; bulunmayan hesapta da aynı süre harcanır. Tek proje modunun pano oturumları da bu ilkelleri kullanır.
- `roles.ts`: insan rolleri owner/admin/member/viewer, AI rolleri reader/contributor/trusted; her rolün yetki listesi ve `trusted` için `{ node: "auto" }` onay istisnası (`Actor.policy`).
- `access.ts`: üyelikten `Access` nesnesi: `can(perm)`, `seesNode`, `seesItem`, `seesActivity`, `restricted` ve `itemSql()` (seesItem'in aynısı, items tablosu üzerinde SQL parçası; listeler bunu LIMIT/OFFSET'ten önce uygular, sayfalar dolu ve toplam doğru gelir).
- `limiter.ts`: tüm kapılar için ortak deneme sınırlayıcısı (süresi dolanlar zamanlayıcıyla silinir, anahtar sayısı üst sınırlı).
- `knowledge.ts`: bilginin nerede durduğu (aşağıda), `registerProject` (pano ve CLI ortak), `moveKnowledge`, `commitKnowledge`.
- `server.ts`: `Hub` her projeyi ilk kullanımda açar (`openHubProject` → `Cortex` + watch) ve üyeleri bellekte aktör listesine ekler (`syncActors`, dosyaya yazmaz); `forget(id)` açık projeyi kapatır. `buildHubServer`: giriş, davet, organizasyon yönetimi (/api/admin/*), proje API'si (/api/p/:project/*, ortak `projectRoutes`) ve üyeler.
- `backup.ts`: hub yedeği (aşağıda "Yedekleme").

## Kurallar
- Organizasyon yöneticileri her projede Sahip sayılır; son sahip çıkarılamaz; sahipliği yalnızca sahipler değiştirir; kendini devre dışı bırakamazsın, son organizasyon yöneticisi kaldırılamaz.
- AI hiçbir rolde onaylayamaz, kural değiştiremez, üye yönetemez (rol listesinde yok, çekirdek de insan ister).
- Görünürlük: scope `own` = yazdığı veya kendisine/grubuna (@humans, @ai) atanan kayıtlar; `branches` = yalnızca o dallar (atası olan dallar gezinmek için görünür). Gizli olan 404 döner.
- Deneme sınırları (15 dakikalık pencere): adres+e-posta başına 10 hatalı şifre; adres başına 10 hatalı ajan token'ı (REST ve `/mcp/p/:project` birlikte); adres başına 20 geçersiz davet bağlantısı. Aşılınca 429.
- **Üyeliği olmayan istek:** 403 ve mesaj iki tarafı da yazar — `opencode is not a member of "app-api"`. Geçersiz token `unauthorized`, geçerli token + eksik üyelik `forbidden`; ikisi karışmasın diye ayrı.
- **Dışarıdan verilen üyelik anında geçerli:** erişimi `members` satırı belirler (her istekte okunur), projenin bellekteki aktör listesi de tanımadığı bir üye gelince tazelenir (`syncActors`, proje kapsamının `preHandler`'ında). Yani `cortexboard hub member` ile verilen erişim için hub'ı yeniden başlatmak gerekmez.
- **Organizasyon kavramı yok, tek düz hub:** `User.org_admin` sadece bir bayrak; true ise o kişi her projede otomatik Sahip sayılır. Birden fazla, birbirinden habersiz taraf hub'a girerse bu ayrı bir tur olarak ele alınmalı (bkz. karar `01M35AS75BZVM32EFWX3HBCW4H`: mobil ekip mevcut proje+üyelik modeliyle ayrı proje olarak katılabiliyor).
- **`GET /api/p/:project/members/candidates`**: org_admin için tüm hub roster'ı; org_admin olmayan proje sahibi/yöneticisi için yalnızca başka bir projede de owner/admin olduğu kişi/ajanlarla sınırlı. E-posta ile davet bu listeden bağımsız.
- Bilinen sınır: hub açtığı her projeyi yeniden başlayana kadar bellekte tutar (CHANGELOG'da yazılı).

## AI ajanları nasıl bağlanır
`cortexboard mcp --hub <url> --project <id> --token <t>`: MCP araçları merkezdeki proje API'sini kullanır (`remoteApi`), ajanın rolü ve görünürlüğü aynen geçerlidir. Bu bilgisayarda çalışmayan AI'lar (ör. ChatGPT) için MCP'nin HTTP ucu: `POST <url>/mcp/p/<proje>`, `Authorization: Bearer <ajan tokenı>`, durumsuz (GET ve DELETE 405). İstek aynı proje rotalarına yeniden yollanır; token, rol ve görünürlük REST ile birebir aynıdır.
**Ajanın çalıştığı istemcinin kendi yapılandırması ayrı bir konudur:** ajan bağlanamıyorsa sırayla bak — istemci hangi dosyayı okuyor (OpenCode `opencode.json(c)` içinde düz `mcp` haritası; `.mcp.json` Claude Code'undur), adres çözülüyor mu, token isteğe gidiyor mu, ajan o projeye üye mi.

## Komutlar
`cortexboard hub init | start | add-project [--in-repo] | move-knowledge | set-path | member | pull | invite | backup [setup|list|connect-google] | restore` (`src/cli.ts` → `hubCommand`). Tek proje için `cortexboard backup [setup|list|connect-google|restore]`.

## Alt düğümler

- `backend/hub/backup`: hub yedekleme.
- `backend/hub/screens`: hub ekranları ve rol yetkileri.
- `backend/hub/knowledge`: hub'da bilginin yeri ve git.
- `backend/hub/linked`: bağlı projeler.
