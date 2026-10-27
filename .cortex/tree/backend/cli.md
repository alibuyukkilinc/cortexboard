---
title: Komut satırı (CLI)
summary: "`cortexboard` komutları: init, start, login, logout, mcp, bootstrap,
  reindex, semantic, report, version ve ekip sunucusu için hub init | start |
  add-project | member | invite. Her proje komutu `--dir` ya da CORTEX_DIR ile
  başka bir klasörü hedefleyebilir."
links:
  code:
    - file: src/cli.ts
    - file: src/core/init.ts
    - file: src/core/agentFiles.ts
    - file: src/util/runtime-check.ts
verified_at_commit: b2ffcf3274cd981a82cd0839e44e5d900cde3a64
id: 01M34QY9W1VNPQMRXK141RRDFS
status: active
updated_by: ai-agent
updated_at: 2026-09-24T20:05:09.027Z
---

- Proje hangi klasörde: `--dir <klasör>`, yoksa `CORTEX_DIR`, yoksa çalışılan klasör (git gibi yukarı doğru aranır). Claude Desktop ve Codex MCP sunucularını proje klasöründe başlatmadığı için `mcp --dir` gerekir; `init --dir` projeyi o klasörde oluşturur (klasör yoksa açar). `hub` komutlarında `--dir` hub'ın veri klasörüdür (varsayılan `~/.cortex/hub`, `CORTEX_HUB`).
- `init`: .cortex/ klasörünü, token'ları (`.secrets.yaml`, 0600), `.gitattributes` (LF + aktivite günlüğü için `merge=union`), varsayılan kuralları ve üst dalları oluşturur. Dalları terminalde numaralı listeyle sorar (Enter = hepsi); `--branches a,b,c` ile sormadan seçilir. `--agent-files` var olan CLAUDE.md/AGENTS.md dosyalarına kısa bir Cortex notu ekler (bir kez); yalnızca `@AGENTS.md` ile AGENTS.md'yi içe aktaran CLAUDE.md'ye eklemez (Claude notu iki kez okurdu).
- **`--lang tr` iki şey yapar:** AI'ların yazım dilini kurala yazar ve kurulumun ağaca koyduğu metinleri (dal başlıkları, özetleri, "(henüz belgelenmedi)" eki, kök düğümün yer tutucusu, bootstrap görevinin başlığı) o dilde yazar. Metinler `src/core/init.ts` içinde dil başına bir tabloda; şu an `en` ve `tr` var, tablosu olmayan dil İngilizce alır. `--lang` verilmezse makinenin dili kurala yazılır, ama tabloyu seçen her çağrı dili açıkça geçirir.
- **Bootstrap görevi (commit c735ada):** `init` ağacı doldurma talimatını gerçek bir kayıt olarak açar: tür `task`, durum `todo`, öncelik `high`, `@ai`'a atanmış, etiket `bootstrap`, başlık "Bilgi ağacını koddan doldur (ilk kurulum)", gövde `bootstrapPrompt(..., asTask=true)` (görevi claim etmeyi, bitince "review"a almayı, büyük projede oturumlara bölüp devir notu bırakmayı da söyler).
  - Neden: talimat eskiden yalnızca `cortexboard bootstrap` ile ekrana yazılıyordu; hub'a token'la bağlanan ajan boş bir ağaç görüyor, ne yapacağını bilmiyordu. Artık yerelde de hub'da da ilk AI onu gelen kutusunda bulur, pano ilerlemeyi gösterir.
  - Kök özet hâlâ yer tutucuysa (`isPlaceholder`) brief'in `next` alanı yalnızca bu adımı gösterir; genel ipuçları kök özeti yazılınca döner. Ayrı alan yerine `next`'in yerini alması bilinçli: brief 800 token sınırında, bir test senaryosu değişiklikten önce 797'deydi.
  - `initProject(..., { bootstrapTask: false })` görevi açmaz; kalem sayan testler (`test/helpers.ts` ve hub testleri) bunu kullanır. `InitResult.bootstrapTask` görevin kimliği ya da null.
- **İçe aktarılacak belgeler (`findMarkdown`, commit 0d6da28):** git reposunda liste `git ls-files --cached --others --exclude-standard` ile gelir, yani `.gitignore`'daki dosyalar asla listelenmez; git dışında klasör taranır ve `*.local.md` atlanır; sınır 200.
  - Neden: gerçek bir proje kurulumunda eski tarama `.gitignore`'daki `docs/ai/infra.local.md`'yi (gerçek sunucu anahtarları) listeledi; AI onu içe aktarsaydı commit'lenen `.cortex/`'e sızardı. Eski 50 sınırı da 51 belgeli klasörde DR runbook'unu düşürdü. Görev metni ayrıca gizli bilginin Cortex'e asla kopyalanmamasını söyler.
- `bootstrap`: aynı görev metnini elle vermek için yazdırır (Cortex hiç token harcamaz).
- `login`: pano için 10 dakika geçerli, imzalı bir giriş bağlantısı yazdırır (`--actor`, `--port`).
- `logout [--actor <id>] [--all]`: pano oturumlarını bitirir; çalışan sunucu oturum dosyasını yeniden okur.
- `mcp [--actor <id>]`: stdio üzerinden MCP; `--hub <url> --project <id> --token <t>` (ya da `CORTEX_HUB_URL`, `CORTEX_PROJECT`, `CORTEX_TOKEN`) ile merkezdeki projeye bağlanır.
- `version` / `--version` / `-v`: kurulu sürümü yazar (`src/util/version.ts`, package.json'dan; MCP sunucusunun `serverInfo`'su da aynı yerden gelir).
- Hatalı kullanımda `✖ mesaj` stderr'e yazılır ve çıkış kodu 1 olur; bilinmeyen komut yardımı yazar, çıkış kodu 1. `test/cli.test.ts` gerçek alt süreçle denetler (`--dir` dahil).
- node:sqlite uyarı filtresi, node:sqlite yüklenmeden önce çalışmalı; komutların modülleri geç yüklemesinin sebebi bu.
- Her komuttan önce Node sürümüne bakılır: 22.16'dan eskiyse açık bir mesajla durur (`src/util/runtime-check.ts`).
- `hub init --org --admin-email --admin-name [--public-url]` merkezi ve ilk yöneticiyi oluşturup 48 saatlik şifre belirleme bağlantısını yazar; `hub start [--host 0.0.0.0]` ağa açılırken HTTPS yoksa uyarır; `hub add-project <klasör> [--init [--lang tr] [--branches a,b]]` (panodaki "Proje ekle" = `POST /api/admin/projects`, `branches` dizi ya da virgüllü metin); `hub invite <e-posta>`.
- **`hub member <proje> <kim> [--role contributor] [--scope all|own] [--branches a,b] [--remove]`** (commit f7c7d80): kişiye ya da AI ajanına proje erişimi verir; panodaki Üyeler sayfasının yaptığının aynısı. Doğrulamayı `HubStore.setMember` yapar (proje ve kimlik var mı, rol o türe uygun mu). Neden var: geçerli bir ajan tokenı üyelik olmadan 403 alıyordu ve bunu düzeltmenin tek yolu panoydu. Üyelik bir sonraki istekte geçerli, yeniden başlatma gerekmez.
