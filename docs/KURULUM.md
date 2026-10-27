# Cortex kurulumu

Bu rehber hiçbir şey bildiğini varsaymaz. Node.js, MCP ya da terminalle pek çalışmadıysan baştan başla ve
sırayla ilerle; biliyorsan doğrudan [Kurulum türünü seç](#kurulum-türünü-seç) bölümüne geç.

🇬🇧 English: [INSTALL.md](INSTALL.md)

- [Neler gerekiyor](#neler-gerekiyor)
- [Kurulum türünü seç](#kurulum-türünü-seç)
- [Kurulum A: kendi bilgisayarında tek proje](#kurulum-a-kendi-bilgisayarında-tek-proje) (çoğu kişi)
- [AI aracını bağla](#ai-aracını-bağla)
- [Kurulum B: ekip sunucusu (hub)](#kurulum-b-ekip-sunucusu-hub)
- [İsteğe bağlı: anlamla arama](#isteğe-bağlı-anlamla-arama)
- [Güncelleme](#güncelleme)
- [Sorun giderme](#sorun-giderme)
- [Cortex'i kaldırmak](#cortexi-kaldırmak)

---

## Neler gerekiyor

| | Neden | Nasıl kontrol edilir |
|---|---|---|
| **Node.js 22.16 veya üstü** | Cortex bir Node.js programı. Başka hiçbir şey kurulmaz: veritabanı, Docker ya da API anahtarı yok. | `node -v` → `v22.16.0` ya da üstü |
| **git** (önerilir) | Bilginin eskidiğini commit'lere bakarak anlar. git olmadan her şey çalışır, yalnızca bu özellik kapalı kalır. | `git --version` |
| **MCP konuşan bir AI kodlama aracı** | Claude Code, Cursor, Copilot'lu VS Code, Claude Desktop, Codex… AI, Cortex'i MCP ile okur ve yazar. | ([AI aracını bağla](#ai-aracını-bağla)) |

**Node.js kurmak:** [nodejs.org](https://nodejs.org) adresinden **LTS** sürümünü indirip kur (Windows,
macOS) ya da Linux'ta paket yöneticini kullan. Sonra **yeni** bir terminal açıp `node -v` ile kontrol et.
Yanında `npm` ve `npx` gelir; Cortex'in ihtiyacı olan bu kadar.

> **Terminal**: Windows'ta "Komut İstemi" ya da "PowerShell", macOS'ta "Terminal". Aşağıdaki her komut
> orada, projenin klasöründe yazılır (`cd projenin/yolu`).

---

## Kurulum türünü seç

| | **A. Kendi bilgisayarında tek proje** | **B. Ekip sunucusu (hub)** |
|---|---|---|
| Kimin için | Tek kişi (ve AI'ları), bir ya da birkaç repo | Ekip: birden çok kişi, birden çok proje, AI ajanları |
| Başlangıç | `npx cortexboard init`, sonra `npx cortexboard start` | `npx cortexboard hub init`, sonra `npx cortexboard hub start` |
| Kim erişir | Yalnızca bu bilgisayar (localhost) | Davet ettiğin herkes, HTTPS üzerinden |
| Giriş | Terminalin yazdığı tek kullanımlık bağlantı, şifre yok | E-posta + şifre (davet bağlantısı), AI ajanları token ile |
| Roller | Sen (insan) ve AI'ın | Sahip, Yönetici, Üye, İzleyici; AI Okuyucu, Katkıcı, Güvenilir; proje başına |
| Bilgi nerede durur | Repoda: `.cortex/`, kodla birlikte commit'lenir | Yine her reponun `.cortex/` klasöründe; hub yalnızca kişileri ve üyelikleri tutar |
| AI bağlantısı | Proje klasöründe başlatılan MCP | Ajan token'ıyla hub'a MCP, uzaktaki AI'lar için HTTP üzerinden MCP |

**A ile başla.** Bir projeyi sonradan hiçbir şeyini değiştirmeden hub'a taşıyabilirsin: hub yalnızca
klasörü kaydeder.

**Komutları çalıştırmanın üç yolu.** Örneklerin hepsi `npx cortexboard …` kullanır: paketi ilk seferde
indirir, kurulum gerektirmez. İstersen:

| | Komut | Ne zaman |
|---|---|---|
| `npx` (varsayılan) | `npx cortexboard start` | Hiçbir şey kurulmaz; istediğin sürüm çalışır |
| Genel kurulum | `npm install -g cortexboard`, sonra `cortexboard start` | Birçok projede her gün kullanıyorsan |
| Proje bağımlılığı | `npm install -D cortexboard`, sonra `npx cortexboard start` | Ekibin tamamı `package.json`'dan aynı sürümü alsın |

---

## Kurulum A: kendi bilgisayarında tek proje

### 1. `.cortex/` klasörünü oluştur

Proje klasöründe:

```bash
npx cortexboard init
```

Projenin hangi üst bilgi dallarına ihtiyacı olduğunu sorar (backend, frontend, mobil…); hepsi için Enter'a
bas ya da numaralarla ve kendi adlarınla cevap ver. Soruyu atlamak için:

```bash
npx cortexboard init --branches backend,frontend,odeme --lang tr
```

`--lang`, AI'ların bilgiyi hangi dilde yazacağıdır (`tr`, `en`, …; verilmezse bilgisayarının dili).
İki **token** yazdırır (biri senin, biri AI'ın). Nadiren gerekir; hiç commit'lenmeyen
`.cortex/.secrets.yaml` dosyasında saklanır.

Oluşturduğu yapı:

```
.cortex/
├── cortex.config.yaml   kişiler ve AI'lar, onay politikası, saat dilimi   → commit'le
├── rules/               her AI'ın uyduğu kurallar (yalnızca insan)        → commit'le
├── tree/                bilgi, her sayfa bir Markdown dosyası             → commit'le
├── items/               görevler, sorunlar, sorular, kararlar, ekleri     → commit'le
├── activity/            hangi AI ne yaptı ve neden                         → commit'le
├── drafts/              onayını bekleyen AI değişiklikleri                → commit'le
├── .secrets.yaml        token'lar                                          → asla (git'e girmez)
├── .sessions.json       pano girişleri                                     → asla (git'e girmez)
└── .index/              arama önbelleği, dosyalardan yeniden kurulur       → asla (git'e girmez)
```

Diğer kodlar gibi commit'le: `git add .cortex && git commit -m "Cortex eklendi"`. İçindeki her şey düz
metindir; her düzenleyicide okunur, pull request'lerde incelenir.

### 2. Panoyu aç

```bash
npx cortexboard start
```

Adresi (`http://localhost:4747`) ve bir **giriş bağlantısı** yazdırır. Bağlantıyı tarayıcıda aç: şifre
yok, doğrudan içeridesin. Bağlantı 10 dakika geçerli; `npx cortexboard login` yenisini yazar. Panoyu
kullandığın sürece terminal açık kalsın (Ctrl+C durdurur).

4747 portu dolu mu? `npx cortexboard start --port 4800`.

### 3. AI'ını bağla ve ağacı doldur

`init` ilk iş olarak AI için bir görev açar: **"Bilgi ağacını koddan doldur (ilk kurulum)"**. Görev `@ai`'a
atanır ve panoda görünür. [AI aracını bağla](#ai-aracını-bağla) (sonraki bölüm), sonra AI'ına yalnızca
"Cortex'teki görevine başla" de. Görevi gelen kutusunda bulur, brief de ağaç doldurulana kadar ona önce bunu
yapmasını söyler. AI kod tabanını okur ve bilgi ağacını yazar. Aynı metni elle vermek istersen
`npx cortexboard bootstrap` yazdırır.

Yazdığı her sayfa
**taslak** olarak gelir; panoda **Onaylar** altından onayla (topluca da onaylanabilir). Bundan sonra AI her
oturuma projeyi baştan okumak yerine kısa bir özetle başlar, emin olmadığında sana **Bildirimler**'den
sorar.

---

### 4. Yedekleme (isteğe bağlı)

Hub'da olmayan bir proje de bilgisini aynı yerlere (BunnyCDN ya da Google Drive) yedekleyebilir: panonun
menüsünde **Yedekleme**, ayarlar hub'ınkiyle aynı (Kurulum B, bölüm 8). Arşiv, token'lar, oturumlar,
arama indeksi ve kişisel görünümler dışında `.cortex`'tir; ayarlar `cortex.config.yaml`'da (`backup:`),
anahtarlar `.cortex/backup.secrets.yaml`'da (git dışı). Zamanlı yedekler `cortexboard start` açıkken
çalışır.

Geri yükleme `.cortex`'i yerinde değiştirir; önceki hali önce `.cortex/.restore/before-<zaman>` altına
taşınır. Sonra panoyu ve AI oturumlarını yeniden başlat.

```bash
npx cortexboard backup setup --zone yedeklerim --key <alan şifresi>   # ya da --provider gdrive ...
npx cortexboard backup                # şimdi
npx cortexboard backup list
npx cortexboard backup restore <ad ya da indirilen dosya> --passphrase <anahtar>
```

## AI aracını bağla

Cortex, AI aracının kendisinin başlattığı bir **MCP sunucusu** olarak çalışır. Komut hep aynıdır:

```
npx cortexboard mcp --actor ai-agent
```

**proje klasöründe** başlatılır (araç onu başka bir yerde başlatıyorsa `--dir <proje klasörü>` ile).
Aracını seç:

**Claude Code** (proje klasöründe):

```bash
claude mcp add cortex -- npx cortexboard mcp --actor ai-agent
```

**Cursor** (projede `.cursor/mcp.json`) ve **`.mcp.json` okuyan her araç**:

```json
{
  "mcpServers": {
    "cortex": { "command": "npx", "args": ["cortexboard", "mcp", "--actor", "ai-agent"] }
  }
}
```

**Copilot'lu VS Code** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "cortex": { "type": "stdio", "command": "npx", "args": ["cortexboard", "mcp", "--actor", "ai-agent"] }
  }
}
```

**Claude Desktop** (Ayarlar → Geliştirici → Yapılandırmayı düzenle). Sunucuları projende başlatmaz, bu
yüzden proje klasörünü yaz:

```json
{
  "mcpServers": {
    "cortex": { "command": "npx", "args": ["cortexboard", "mcp", "--actor", "ai-agent", "--dir", "C:/kod/magaza"] }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):

```toml
[mcp_servers.cortex]
command = "npx"
args = ["cortexboard", "mcp", "--actor", "ai-agent", "--dir", "/home/ben/kod/magaza"]
```

> **Windows ve `npx`:** bir araç `npx`'i bulamadığını söylerse `"command": "cmd"` yaz ve `args`'ın başına
> `"/c", "npx"` ekle.

AI'ın Cortex'i iyi kullanması için `npx cortexboard init --agent-files`, var olan `CLAUDE.md` / `AGENTS.md`
dosyasına kısa bir Cortex bölümü ekler. Çalıştığını denemek için AI'ına *"cortex_brief'i çağır"* de; proje
özetiyle ve dallarla cevap vermeli.

**Birden fazla AI mı var?** `.cortex/cortex.config.yaml` dosyasına aktör ekle (ör.
`{ id: cursor, kind: ai }`) ve her birini kendi `--actor`'ıyla başlat; aktivite akışı kimin ne yaptığını
gösterir.

### AI sohbetinden onay

Cortex'i güncel tutmak için panoyu açman gerekmez. AI bir işi bitirdiğinde sana sohbette sorar: taslaklarını
onayla, bir kararı kabul et, bir soruyu cevapla, bir görevi kapat. Sen cevap verirsin; Cortex cevabı senin
adına, nereden geldiğiyle birlikte kaydeder.

- **Soruyu Cortex kendisi yazar**, gerçek kayıttan: taslağın farkı, kararın metni, görev kartı. AI'ın notu
  altta yalnızca bağlam olarak görünür.
- **Cevap AI istemcinin kendi penceresinden gelir** (MCP *elicitation*), modelden geçmez. AI senin yerine
  cevap veremez.
- **Her cevap kaynağıyla kaydedilir:** senin kimliğin, soran AI, oturum ve sana gösterilen metnin özeti
  (hash). Panoda **"AI sohbetinden"** rozeti taşır. **Aktivite → AI sohbetinde cevaplananlar** altında
  hepsini görür, istediğini **geri alırsın**; kart eski hâline döner.
- **AI işi bitirince** taslaklarını onaylatır (`cortex_review_drafts`). Kalıcı bir karar ya da kural
  söylediğinde kaydetmeyi önerir (`cortex_capture`). Onayladığın şey senin adına, taslak olmadan, hemen
  geçerli olarak yazılır.

Onaylar `cortex.config.yaml`'daki ilk insan aktör adına kaydedilir; başkası için `--human <id>` ver.

**İstemciler.** MCP elicitation hakkında bugün bildiklerimiz. Cortex ile şimdiye kadar yalnızca SDK'nın test
istemcisi denendi; gerisi her istemcinin belgelerinden ya da hata kayıtlarından.

| İstemci | Elicitation | Ne yapmalı |
|---|---|---|
| Claude Code | destekliyor (form penceresi) | bir şey gerekmez |
| Cursor | desteklediği yazıyor | bir şey gerekmez; pencere çıkmazsa bize bildir |
| Codex CLI | destekliyor görünüyor ama istekleri pencere açmadan reddediyor ([openai/codex#45621](https://github.com/openai/codex/issues/45621)) | `--no-elicitation` ile başlat |
| opencode | destekliyor görünüyor ama isteklere hiç cevap vermiyor ([anomalyco/opencode#51856](https://github.com/anomalyco/opencode/issues/51856)) | `--no-elicitation` ile başlat |
| VS Code Copilot, Claude Desktop, diğerleri | henüz bakılmadı | dene; pencere çıkmazsa `--no-elicitation` |

**Elicitation yoksa** (ya da `--no-elicitation` ile) AI senin sözünü birebir alıntılar
(`cortex_record_human_answer`). Sonrası `cortex.config.yaml`'da belirlenir:

```yaml
chat:
  relayed: accept      # accept: uygulanır, "doğrulanmadı" diye işaretlenir (kendi bilgisayarında varsayılan)
                       # pending: Onaylar → "AI sohbetinden aktarılanlar" altında seni bekler (hub'da varsayılan)
                       # off: reddedilir, cevabı panoda ver
  max_batch: 10        # tek soruda en fazla taslak
  relayed_human_only: false   # true: aktarılan cevap kararları da kabul edebilir, görevleri de kapatabilir
```

10 dakika cevapsız kalan soru kendiliğinden kapanır, hiçbir şey değişmez.

---

## Kurulum B: ekip sunucusu (hub)

Tek sunucu, çok proje, şifreli kişiler, token'lı AI ajanları. Her proje bilgisini yine kendi reposunda
tutar; hub o klasörleri okur.

### 1. Hub'ı oluştur (sunucuda)

```bash
npx cortexboard hub init --org "Acme" --admin-email sen@acme.com --admin-name "Adın" --public-url https://cortex.acme.com
```

Verisini `~/.cortex/hub` altında tutar (`--dir` ya da `CORTEX_HUB` ile değişir): kişiler, şifre özetleri,
oturumlar, ajanlar ve üyelikler. **Bu klasörü yedekle, asla commit'leme.** Şifreni belirlemen için bir
bağlantı yazdırır (48 saat geçerli).

### 2. Projeleri kaydet

Sunucuda her reponun bir kopyası olmalı. Sonra:

```bash
npx cortexboard hub add-project /srv/repos/magaza                                            # .cortex/ zaten var
npx cortexboard hub add-project /srv/repos/blog --init --lang tr --branches backend,frontend  # önce bilgiyi oluşturur
```

ya da panoda: **Organizasyon → Projeler → Proje ekle**.

**Bilgi nerede durur.** Hub'da oluşturulan bir projenin (`--init`) bilgisi kod reposunda değil, hub'ın
klasöründe durur (`~/.cortex/hub/projects/<id>`). Geliştiricilerin klonunda eskiyebilecek ya da hub'ı
atlayarak düzenlenebilecek bir `.cortex/` olmaz. Hub'ın yazdığını da kimsenin commit'lemesi gerekmez: hub
onu o klasörde dakikada bir commit'ler (`hub.yaml`'da `commit_seconds`) ve hiçbir yere push etmez. O klasörü
hub'ın geri kalanıyla birlikte yedekle. `--in-repo` eski düzeni korur (`<repo>/.cortex`, kodla commit'lenir).
`.cortex/` klasörü zaten olan bir repo olduğu gibi kaydedilir; `cortexboard hub move-knowledge <proje>`
(hub durdurulmuşken) onu hub'a taşır ve kopyadan siler. Repoda commit'liyse silinmesini sen commit'lersin.

Cortex'i hiç kullanmamış bir proje (`--init`) boş bir iskeletle başlar: seçtiğin dallar ve AI için açılmış
**"Bilgi ağacını koddan doldur"** görevi. Projeye eklediğin ilk AI ajanı ([5. adım](#5-ai-ajanlarını-huba-bağla))
bu görevi gelen kutusunda bulur; kimsenin sunucuda komut çalıştırıp metin kopyalaması gerekmez. Ajanın rolü
**Katkıcı** olursa yazdıkları taslak düşer; ekip ağacı panodaki **Onaylar** sayfasından (topluca) onaylar.
Büyük bir projede AI görevi birkaç oturuma bölebilir: görevi bırakırken nerede kaldığını not eder.

### 3. HTTPS arkasında çalıştır

Hub kişileri şifreyle içeri aldığı için **HTTPS** ile erişilmeli. Sunucunun kendi loopback adresinde
çalıştır ve önüne bir ters vekil koy. [Caddy](https://caddyserver.com) ile (sertifikalar kendiliğinden):

```
# /etc/caddy/Caddyfile
cortex.acme.com {
  reverse_proxy 127.0.0.1:4747
}
```

ve hub'a o vekilin arkasında olduğunu `~/.cortex/hub/hub.yaml` dosyasında söyle:

```yaml
public_url: https://cortex.acme.com
trust_proxy: true                 # https'i ve istemci adresini vekilden al
allowed_hosts: [cortex.acme.com]  # yalnızca bu ada cevap ver
```

Aynı üç ayar ortam değişkeniyle de verilir ve `hub.yaml`'daki değerin yerine geçer; adres (ör. bir tünel)
değişince tek değişkeni değiştirmek yeter: `CORTEX_PUBLIC_URL`, `CORTEX_TRUST_PROXY` (`1`),
`CORTEX_ALLOWED_HOSTS` (virgülle, ör. `cortex.acme.com,localhost,127.0.0.1`). Hub her cevaba güvenlik
başlıkları ekler (çerçeveye gömülmez, betikler yalnız kendi adresinden); https arkasında HSTS de gönderir.

Başlat (systemd, pm2 ya da platformunun servis yöneticisiyle açık tut):

```bash
npx cortexboard hub start            # 127.0.0.1:4747'de dinler
```

<details>
<summary>systemd örneği</summary>

```ini
# /etc/systemd/system/cortex-hub.service
[Unit]
Description=Cortex hub
After=network.target

[Service]
User=cortex
ExecStart=/usr/bin/npx --yes cortexboard@0.2.2 hub start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now cortex-hub`
</details>

Güvendiğin bir yerel ağda HTTPS olmadan doğrudan ağa açmak (`hub start --host 0.0.0.0`) mümkün; ama
oturum çerezleri o zaman Secure işaretlenir ve düz http ile giriş tutunmaz. `hub.yaml`'da
`cookie_secure: false` yalnızca şifrelerin şifresiz gideceğini bilerek yazılmalı.

### 4. Kişileri davet et, AI ajanlarını ekle

Panoda, **Organizasyon**:
- **Kişiler → Kişi ekle**: e-posta, ad, ilk proje ve rol. Kişiye göndereceğin tek kullanımlık bir bağlantı
  (48 saat) alırsın; şifresini kendisi belirler. Aynı düğme sonradan şifre sıfırlama işi görür.
- **AI ajanları → AI ajanı ekle**: bir kimlik (ör. `claude-code`), ilk proje ve rol. **Token yalnızca bir
  kez gösterilir**; kopyala.
- Her projede **Üyeler** sayfası rolü ve her üyenin **ne göreceğini** belirler: her şeyi, yalnızca kendi
  kayıtlarını, isteğe bağlı yalnızca bazı dalları (ör. yalnızca `mobil`).

| Rol | Kimin için | Ne yapabilir |
|---|---|---|
| Sahip, Yönetici | kişiler | her şey, üyeler ve kurallar dahil |
| Üye | kişiler | kayıtlar ve bilgi üzerinde çalışır, AI taslaklarını onaylar |
| İzleyici | kişiler | okur, soru sorar ve cevaplar |
| Okuyucu | AI | okur |
| Katkıcı | AI | kayıtlar üzerinde çalışır; bilgi yazımları onay bekler |
| Güvenilir | AI | Katkıcı gibi, bilgi yazımları doğrudan geçer |

### 5. AI ajanlarını hub'a bağla

Bir geliştiricinin bilgisayarında (araç kendisi başlatır; proje klasörü gerekmez):

```bash
claude mcp add cortex -- npx cortexboard mcp --hub https://cortex.acme.com --project magaza --token <ajan token'ı>
```

ya da `CORTEX_HUB_URL`, `CORTEX_PROJECT`, `CORTEX_TOKEN` ortam değişkenleriyle. Senin makinelerinde
çalışmayan bir AI (ChatGPT, sunucuda çalışan bir ajan) `https://cortex.acme.com/mcp/p/magaza` adresine
`Authorization: Bearer <ajan token'ı>` ile **HTTP üzerinden MCP** bağlanır. Hangi yolla gelirse gelsin
ajanın rolü ve görünürlüğü geçerlidir.

**Hub'da AI sohbetinden onay** ([nasıl çalışır](#ai-sohbetinden-onay)): her kişi panoda bir **sohbet
anahtarı** oluşturur: avatar menüsü → *AI sohbetinden onay*. Anahtar tek bir proje içindir ve yalnızca bir
kez gösterilir. Kendi MCP komutuna ekle:

```bash
claude mcp add cortex -- npx cortexboard mcp --hub https://cortex.acme.com --project magaza --token <ajan token'ı> --human-token <sohbet anahtarın>
```

(ya da `CORTEX_HUMAN_TOKEN`). Cevapların senin adına ve senin rolünle kaydedilir; İzleyici rolündeki
birine taslak onayı hiç sorulmaz. Sohbet anahtarı yalnızca projesini okuyabilir ve sohbette verilen
cevapları kaydedebilir. Panonun şifresi değildir; aynı menüden iptal edebilirsin. HTTP üzerinden MCP
sohbette soru soramaz (oturum tutmaz); yukarıdaki komutu kullan.

### 6. Bağlı projeler: bir uygulamanın başka projenin bilgisini okuması

Bir repo bir projedir. Mobil uygulama backend'in API'sini, auth akışını ve kurallarını bilmek zorundaysa,
panelde **Organizasyon → Projeler → Bağlı projeler → Bağla** ile mobil projeyi backend'e bağla. Aynı pencerede
"AI ajanlarını Okuyucu olarak ekle" işaretliyse mobil projenin ajanları backend'e Okuyucu olarak eklenir.
Panel bağlantıyı projenin `cortex.config.yaml` dosyasına yazar; elle yazmak da olur:

```yaml
linked: [backend]
```

Mobil ajan tek MCP bağlantısıyla devam eder. `cortex_brief` bağlı projeleri listeler; `cortex_search`,
`cortex_tree`, `cortex_node`, `cortex_items` ve `cortex_item` `project: "backend"` ile orada okur.
Bağlantı erişim izni değildir: ajan backend'de de üye olmalı (Okuyucu yeter) ve o üyeliğin dal ve kapsam
sınırları geçerlidir. Bağlı okumalar oradaki rol ne olursa olsun salt okumadır; soru ve yazma ajanın
kendi projesinde kalır.

### 7. Hub'daki kopyaları güncel tutmak

Hub her projeyi kendi makinesindeki bir klasörden okur. Geliştiricilerin push ettikleriyle o kopyanın
güncel kalması için (eskime tespiti güncel koda göre çalışır) hub'ın çekmesine izin ver:

```yaml
# ~/.cortex/hub/hub.yaml
pull_minutes: 5
```

ya da elle `cortexboard hub pull [proje]` veya Organizasyon → Projeler'deki **Çek** düğmesi. Hub yalnızca
ileri sarar ve kod reposunda commit ya da push yapmaz. Bilgisi hâlâ repoda duran bir projede (`--in-repo`)
hub'ın yazdığı bilgi kendi kopyasında kalır ve Projeler sayfası o dosyaları sayar ("3 commit bekliyor"),
bir insan commit'leyene kadar. Ayrışmış dal, yerel commit ya da
gelen commit'lerin dokunduğu yerel düzenleme çekmeyi gerekçesiyle durdurur; hiçbir şey sıfırlanmaz ya da
birleştirilmez. Hub makinesinin uzak repoyu okuyabilmesi gerekir (parola sorusu cevaplanamaz).

### 8. Yedekleme (BunnyCDN ya da Google Drive)

Hub'ı (kişiler, ajanlar, üyelikler) ve bütün projelerin bilgisini tek bir şifreli dosya olarak bir BunnyCDN
depolama alanına ya da bir Google Drive klasörüne yedekler. Panelde **Organizasyon → Yedekleme**.

- **BunnyCDN:** alan adı, bölge ve alanın şifresi (Bunny → Storage → alan → FTP & API Access → Password).
- **Google Drive:** Google Cloud → APIs & Services'te **Google Drive API**'yi etkinleştir, **TVs and
  Limited Input devices** türünde bir OAuth istemcisi oluştur ve OAuth onay ekranını **In production**
  yap ("Testing"de kaldıkça Google girişi 7 günde düşürür). İstemci kimliğini ve gizli anahtarı yapıştır,
  kaydet, sonra **Google Drive'a bağlan**: gösterilen adresi aç, kodu gir, izin ver. Cortex yalnız
  `drive.file` izni ister: kendi oluşturduğu dosyaları görür, Drive'daki başka hiçbir şeyi görmez. Yedekler
  klasör ayarındaki adla bir klasöre gider; aynı hesabı bağlayan başka bir makine onu yeniden bulur.
- **Şifreleme anahtarı:** kendin yaz (12+ karakter) ya da boş bırak, üretilip bir kez gösterilir. Bu
  makineden başka bir yerde sakla: yedekler onsuz açılamaz. Sonra değiştirebilirsin; eski yedekler
  yapıldıkları anahtarla açılır.

Sonra **Şimdi yedekle**; `Her (saat)` 0'dan büyükse hub kendisi o aralıkla yedekler. En yeni `keep`
tanesi kalır, eskileri silinir. Listedeki her yedek **indirilebilir** (şifreli dosya) ya da **geri
yüklenebilir**.

**Panelden geri yükleme** yedeği hazırlar ve hub yeniden başlayınca uygular: **Hub'ı şimdi yeniden
başlat** bunu panelden yapar (Windows'ta hub yeni bir pencerede açılır; systemd altında ya da
`CORTEX_RESTART=exit` ile kapanır ve servis yöneticisi yeniden başlatır). Hub'ın önceki hali yanında
kalır (`hub-before-restore-<zaman>`): geri dönmek için hub'ı durdurup adını geri değiştir. Bu makinenin
adresi, portu ve yedekleme ayarları korunur. Yedek başka bir anahtarla yapıldıysa (örneğin hub yeniden
kurulduysa) o anahtarı gir ve "bundan sonra da bu anahtar kullanılsın"ı işaretle, sonraki yedekler aynı
anahtarla devam etsin.

Başka bir makinede geri yükledikten sonra her projeyi oradaki kod klasörüne yönlendir: **Organizasyon →
Projeler**'de klasörün yanındaki **Değiştir** (ya da `cortexboard hub set-path <proje> <klasör>`).
Bulunamayan klasör işaretlenir. Hub'ın kendi klasöründe tuttuğu bilgi yer değiştirmez.

Yedekte: `hub.db`'nin tutarlı bir kopyası, `hub.yaml`, hub'da tutulan projelerin bilgi klasörleri (git
geçmişiyle), bilgisi repoda duran projelerin `.cortex`'i (geri yükleme bunları `restored-repo-projects/`
altına bırakır, bir insan geri kopyalasın diye). Yedekte olmayanlar: arama indeksleri (yeniden kurulur),
`backup.secrets.yaml` (depolama anahtarları ve şifreleme anahtarı), projelerin yerel token ve oturum
dosyaları.

Terminalden aynısı:

```bash
npx cortexboard hub backup setup --zone yedeklerim --region ny --key <alan şifresi> --every 24 --keep 14
npx cortexboard hub backup setup --provider gdrive --google-client-id <kimlik> --google-client-secret <gizli>
npx cortexboard hub backup connect-google
npx cortexboard hub backup          # şimdi
npx cortexboard hub backup list
npx cortexboard hub restore <dosya ya da ad> --to <boş klasör> --passphrase <anahtar>
npx cortexboard hub set-path <proje> <klasör>
```

`hub restore` çalışan hub'ın üstüne yazmaz: boş bir klasöre açar. İçindeki `hub/` bir hub klasörüdür
(`hub start --dir <klasör>/hub`) ve açıldığı anahtarı saklar; `repo-projects/<id>/` ise repodaki
projelerin `.cortex` klasörleri.


---

## İsteğe bağlı: anlamla arama

Kelime araması hazır gelir ve Türkçe harfleri anlar. Bir şeyi **anlamıyla** da (diller arası) bulmak için
bilgisayar başına bir kez:

```bash
npx cortexboard semantic on
```

Yerel bir model indirir (~420 MB, bir kez, `~/.cortex` altında, bütün projeler ortak kullanır). Hiçbir şey
bilgisayarından çıkmaz. `semantic status` durumu gösterir, `semantic off` kapatır.

---

## Güncelleme

```bash
npx cortexboard@latest start      # npx: yeni sürümü istemen yeterli
npm install -g cortexboard@latest # genel kurulum
```

`.cortex/` klasörün düz dosyalardır ve her sürüm onları okur; arama önbelleği biçimi değişince kendini
yeniden kurar. Nelerin değiştiği [CHANGELOG.md](../CHANGELOG.md)'de. 0.1'den 0.2'ye elle bir şey gerekmez:
açık pano oturumun kapanmadan yeni girişe taşınır, `.cortex/.gitattributes` dosyasına bir kez bir satır
eklenir (commit'le).

---

## Sorun giderme

| Gördüğün | Yapılacak |
|---|---|
| `Cortex needs Node.js 22.16 or newer` | nodejs.org'dan güncel LTS'yi kur, yeni terminal aç. |
| `No .cortex folder found` | Komutu proje klasöründe çalıştır ya da `--dir <proje klasörü>` ver. |
| `address already in use` / port dolu | `npx cortexboard start --port 4800` |
| Giriş bağlantısı süresi dolmuş diyor | `npx cortexboard login` yenisini yazar (10 dakika). |
| Pano açılıyor ama "panoyu terminalden açın" diyor | Oturumun bitmiş; yeni bir giriş bağlantısı kullan. |
| AI aracında `cortex_*` araçları görünmüyor | Sunucuyu ekledikten sonra aracı yeniden başlat; komutun proje klasöründe elle çalıştığını kontrol et. Windows'ta `cmd /c npx` biçimini dene. |
| "Eskimiş bilgi" hiç çıkmıyor | Proje bir git deposu değil ya da değişiklik henüz commit'lenmedi (yalnızca commit'ler sayılır). |
| Hub'a düz http ile giriş tutunmuyor | Beklenen davranış: HTTPS kullan ([Kurulum B](#3-https-arkasında-çalıştır)). |
| Başka bir şey | `npx cortexboard --version`, sonra ne çalıştırdığını ve ne gördüğünü yazarak bir issue aç. |

---

## Cortex'i kaldırmak

- MCP kaydını AI aracından kaldır (`claude mcp remove cortex` ya da JSON'dan sil).
- Genel kurduysan `npm uninstall -g cortexboard`.
- `.cortex/` **projenin bilgisidir**; gerçekten gitmesini istiyorsan sil (git geçmişinde kalır).
  `~/.cortex/` isteğe bağlı arama modelini ve sunucudaysa hub'ın verisini tutar.
