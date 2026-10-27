---
title: Giden webhook'lar
summary: Her aktivite kaydı (AI değişikliği ve nedeni, kayıt açıldı/taşındı,
  taslak, tartışma kararı) yapılandırılmış adrese POST edilir; gizli anahtar
  varsa HMAC-SHA256 imzalı. Yazmayı hiç bekletmez. src/core/webhooks.ts.
links:
  code:
    - file: src/core/webhooks.ts
verified_at_commit: 531735dc5d0e419697dbd9241ba9d483cca158c1
id: 01M3APS65A23TXWWD40YGH10NN
status: active
updated_by: ai-agent
updated_at: 2026-09-25T19:27:45.063Z
---

- Ayar: `cortex.config.yaml` → `webhooks: [{ name, url, events? }]`. `events` eylem adları ya da `item.*` gibi önek; boşsa hepsi.
- Gizli anahtar: git dışı `.secrets.yaml` → `webhooks: { <name>: <secret> }`. Varsa `X-Cortex-Signature: sha256=<gövdenin HMAC'i>`.
- Gövde: `{ event, project, delivered_at, entry }`; başlıklar `X-Cortex-Event`, `X-Cortex-Delivery` (aktivite kimliği).
- Kaydı yazan süreç gönderir (`c.events` "activity" olayı, `entry` taşır). Dosya izleyicisinin "değişti" olayında `entry` yok; bu yüzden aynı kayıt iki kez gitmez. MCP stdio süreci yazdıysa o süreç gönderir.
- Teslim: 5 sn zaman aşımı, ağ hatası ve 5xx'te 2 sn sonra bir kez daha; 4xx tekrar edilmez. Hatalar stderr'e (stdout MCP protokolünün).
- `Webhooks.idle()`: başlamış teslimlerin bitmesini bekler (testler için).
- Testler: `test/webhooks.test.ts` (gerçek yerel HTTP sunucusu, imza, süzgeç, hata).
- Sürüm 0.4.0.
