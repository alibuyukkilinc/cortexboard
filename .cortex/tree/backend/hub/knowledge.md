---
title: Hub'da bilginin yeri ve git
summary: Yeni projelerin bilgisi hub klasöründe, yerel git geçmişiyle, push'suz;
  kod kopyası yalnız pull edilir. Bu repo (cortex projesi) hub'a nasıl bağlı.
links:
  code:
    - file: src/hub/knowledge.ts
    - file: src/hub/gitSync.ts
verified_at_commit: 531735dc5d0e419697dbd9241ba9d483cca158c1
id: 01M3PN87Q4VDY0TQCQHP5V6Y67
status: active
updated_by: claude-code-new
updated_at: 2026-09-29T13:21:48.260Z
---

## Bilgi nerede durur (karar `01M3MXCE60DW7T897TRC43C6AR`)
- **Hub'da (yeni projelerin varsayılanı):** `~/.cortex/hub/projects/<id>`. `Project.root` kod klasörü (git, eskime, kod bağlantıları, `code_context` ona bakar), `Project.dir` hub klasörü (`openProject(root, dir)`, `src/core/project.ts`). Geliştiricilerin klonunda `.cortex/` olmaz: eski kopyayı okuyamaz, hub'ı atlayıp düzenleyemezler.
- Hub bu klasörü kendi git deposu olarak tutar ve `commit_seconds` (varsayılan 60, 0 = kapalı) aralıkla commit'ler (`Hub.commitAll`); **hiçbir yere push etmez.** Sabit kimlik (`Cortex hub`), git ayarı gerekmez. Her commit'ten önce `.gitignore`'da `PRIVATE` satırları (`.index/`, `.secrets.yaml`, `.sessions.json`, `views/`, `backup.secrets.yaml`, `.backup-last.json`, `.restore/`) olduğu denetlenir (taşınan bir `.cortex`'in `.gitignore`'u eksik olabilir).
- Klasör izleyicisi `.git/` altındaki değişiklikleri yok sayar (`Cortex.watch`).
- **Repoda (eski düzen):** `hub add-project --in-repo` ya da panoda `knowledge: "repo"`; `.cortex/` zaten olan bir klasör olduğu gibi kaydedilir. Hangisi olduğuna `knowledgeWhere` bakar: önce hub klasöründe `cortex.config.yaml`, sonra repoda.
- **Taşıma:** `cortexboard hub move-knowledge <proje>`, hub durdurulmuşken. Adımlar sırasıyla:
  1. Denetim: hedefte bilgi varsa ya da kaynakta proje yoksa durur; önceki denemeden kalmış `.cortex.moving` varsa durur.
  2. **Önce yeniden adlandırma:** `.cortex` → `.cortex.moving`. Klasörü başka bir süreç (pano, MCP sunucusu, editör) açık tutuyorsa Windows reddeder; komut `busy` (409) verir ve hiçbir şeye dokunulmamıştır.
  3. `.index` hariç hub klasörüne kopyalar ve ilk commit'i atar.
  4. En son `.cortex.moving`'i siler. Silinemezse `leftover` olarak bildirir (hub kopyayı zaten sunuyor, eli ile silinir).
  Sebep (2026-09-29): ilk sürüm önce kopyalayıp sonra siliyordu; app-web'ta sahipsiz kalmış bir MCP süreci klasörü tutunca silme yarıda kesildi, `.gitignore` ve `.gitattributes` gitti. Repoda commit'liyse silinmesini insan commit'ler. Çalışan hub eski klasörü izlediği için yeniden başlatılmalı.
- Projeler sayfası her proje için "bilgi hub'da / bilgi repoda" etiketi gösterir (`/api/admin/projects` → `knowledge`).

## Git: kod kopyası yalnızca pull (karar `01M3AM8C7QZG19TBK055EJYWXA`, commit 8c9308d)
- `src/hub/gitSync.ts` → `pullProject(dir)`: upstream yoksa atla; `fetch`; geride değilse güncel; yerel commit varsa atla (ayrışma insana); yoksa `merge --ff-only`. Sonuç: durum, mesaj, ahead/behind, `pending` (repodaki `.cortex` altında commit bekleyen dosya sayısı; bilgisi hub'da olan projede 0).
- Asenkron `execFile`, `GIT_TERMINAL_PROMPT=0`, 60 sn zaman aşımı: sunucu olay döngüsü ve parola sorusu yüzünden takılmaz.
- `Hub.pull(id)` proje başına tek çalışan; son sonuç bellekte (`hub.pulls`). `startPulling(pull_minutes)` `hub start`'ta açılır, varsayılan kapalı.
- Uçlar: `GET /api/p/:p/git`, `POST /api/p/:p/git/pull` (insan + approve); `/api/admin/projects` her projenin son çekmesini döndürür, Projeler tablosunda "Git" sütunu ve **Çek** düğmesi.
- CLI: `cortexboard hub pull [proje]`.
- Hub kod reposuna commit/push yapmaz. Bilgisi repoda kalan (`--in-repo`) projelerde biriken `.cortex` değişikliklerini bir insan commit'ler.

## Bu repo (`cortex` projesi) nasıl bağlı (sorun 01M3P46RC52ACJ0TYPCBE3G13A, 2026-09-29)
- Bilgi repoda (`.cortex/`), hub'daki `cortex` projesi bu klasöre kayıtlı. İki kapı var: hub ve repodaki `.mcp.json` (kaynaktan yerel MCP, aktör `ai-agent`).
- **Sahibin makinesi:** `local` kapsamlı bir `cortex` MCP kaydı (`claude mcp add --scope local`) repodaki `.mcp.json`'u ezer ve hub'a bağlanır: `cortexboard mcp --hub https://<hub> --project cortex --token <ajan> --human-token <sohbet anahtarı>`. Bu oturumda AI kimliği `claude-code-mcp` (Güvenilir), onaylar sahibin hub hesabı adına sorulur. Claude Code `/mcp`'de "Conflicting scopes" uyarısı verir: beklenen durum, project kaydı (`.mcp.json`) katkı verenler için kalır, silinmez.
- Kayıt `npx cortexboard` çalıştırır, yani hub'a giden istekleri hub'daki yayınlanmış sürüm karşılar: repodaki yeni kod hub güncellenene kadar orada yoktur.
