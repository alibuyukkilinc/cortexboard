---
title: Anlamla arama (isteğe bağlı)
summary: "`cortexboard semantic on` bilgisayara bir kez yerel model kurar
  (~/.cortex altında, tüm projeler ortak). Vektörler SQLite'ta ve bellekte
  durur; kelime aramasıyla RRF ile birleşir. Ölçüldü: hibrit arama ~7 ms, asıl
  maliyet tek seferlik gömme (~50 ms/belge)."
links:
  code:
    - file: src/search/semantic.ts
    - file: src/search/runtime.ts
    - file: src/search/embedder.ts
verified_at_commit: 531735dc5d0e419697dbd9241ba9d483cca158c1
id: 01M34QY9CTKEHQ7G89037EAWVN
status: active
updated_by: ai-agent
updated_at: 2026-09-24T07:57:58.348Z
---

- Model: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (q8). Çalışma ortamı `@huggingface/transformers`, `~/.cortex/runtime` altına kurulur; npx paketiyle gelmez çünkü ~290 MB.
- `SemanticIndex` yalnızca yeni ya da değişen metinleri vektöre çevirir (metnin özetine bakar), bunu arka planda ve toplu yapar (16'lık gruplar).
- Benzerliği 0.3'ün altındaki sonuçlar atılır (`MIN_SIMILARITY`); ölçümde bunun altı gürültüydü.
- Arama bellekte basit bir çarpım taraması; ayrı bir vektör eklentisi gerekmez.
- Model yoksa veya hata verirse arama sessizce kelime aramasına döner. Her sonuç `keyword`, `semantic` ya da `both` ile nasıl bulunduğunu söyler.
- Bir proje `cortex.config.yaml` içinde `search: { semantic: false }` ile kapatabilir. Testler her zaman sahte bir model kullanır.

## Ölçülen davranış (2026-09-23, gerçek modelle)
| Ne | Süre |
|---|---|
| Model yükleme + ilk gömme (süreç başına bir kez) | 2,3 sn |
| 16 metinlik bir grup | 795 ms (≈50 ms/belge) |
| 300 belgelik projeyi baştan gömme | 26 sn |
| Hibrit arama (kelime + anlam, sorgu gömmesi dahil) | p50 **7,1 ms** (min 4,3 / maks 9,3) |

- Vektör genişliği **384**, yani belge başına 1.536 bayt. 10.000 belge ≈ 15 MB vektör; bellekteki tarama bu ölçekte birkaç milisaniye, yani darboğaz değil.
- Sorgu tarafı ucuz, **maliyet tek seferlik gömmede**: ~20 belge/saniye. Büyük bir içe aktarmadan sonra pano birkaç dakika boyunca hafif takılabilir (ayrı iş parçacığı ya da kuyruk yok, yalnızca grup aralarında `setImmediate`).
- Bilinen pürüz: `kick()` bir kez `state === "error"` olduktan sonra yeniden denemiyor, yani tek bir geçici gömme hatası süreç yeniden başlayana kadar anlam aramasını kapatıyor.

## Vektör eklentisi (sqlite-vec) hâlâ gerekmiyor
`node:sqlite` 22.13'ten beri `loadExtension` sunuyor, yani teknik olarak mümkün. Ama `01M34Q58CAYK4BYD8V50B9QHXC` kararının asıl gerekçesi API eksikliği değil, **`npx` ile her makinede derlemesiz kurulum**tı; platform başına ikili dosya taşımak bunu bozar. Ölçüm de aceleye gerek olmadığını gösteriyor: bellekteki tarama on binlerce belgeye kadar sorgu maliyetinin yanında görünmez kalıyor. Karar geçerli.
