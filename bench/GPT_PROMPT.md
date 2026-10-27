# GPT (Codex) için test promptu

Aşağıdaki metni Codex'te **bu reponun** klasöründe açtığın yeni bir sohbete yapıştır.
Bu sohbetteki GPT yalnızca test yöneticisidir. Asıl ölçülen GPT, betiğin her görev için ayrı başlattığı
temiz `codex exec` oturumlarıdır. Claude tarafındaki koşuları Claude yürütüyor. Sonuçların hepsi aynı
rapora düşer.

---

Bu depoda Cortex için bir ölçüm düzeneği var (`bench/`). Senden GPT tarafındaki koşuları yürütmeni
istiyorum. Ölçülen sen değilsin: betik her görev için ayrı, temiz bir `codex exec` oturumu açıyor.
Senin işin, koşuları başlatmak, izlemek ve sonunda dürüst bir özet vermek.

Kurallar:
- `bench/tasks.json`, `bench/checks.mjs`, `bench/run.mjs` ve fixture klasörüne
  (reponun yanındaki `../cortex-bench-work/`) dokunma. Görevlere ya da cevaplara müdahale etme, yeniden
  puanlama yapma. Koşu yarıda kalırsa nedenini yaz ve yeniden başlat; sonuçları elle düzeltme.
- Koşu klasörlerindeki depolara (`runs/*/repo`) bir şey yazma.
- Git push yapma, commit atma.

Adımlar:
1. `node bench/prepare.mjs` çalıştır. Fixture'lar hazırsa hızlı biter.
2. Önce kısa bir duman testi yap:
   `node bench/run.mjs --agent codex --arm cortex --tasks T4 --label smoke`
   Çıktıda `T4 x/10`, sıfırdan büyük token ve en az bir `cortex_bench.*` çağrısı görmelisin
   (`runs/<koşu>/logs/T4.jsonl`). MCP bağlanmadıysa ya da token 0 ise dur, günlüğün son 30 satırını göster.
   Tek görevlik koşular rapora girmez, dosyayı silmene gerek yok.
3. Tam koşular. Arka arkaya, **paralel değil** çalıştır:
   - `node bench/run.mjs --agent codex --arm cortex`
   - `node bench/run.mjs --agent codex --arm baseline`
   Her biri 8 görev, görev başına en çok 20 dakika. Varsayılan model, `~/.codex/config.toml`'daki model.
4. Zamanın ve kotan varsa aynı iki koşuyu daha yüksek akıl yürütme düzeyiyle tekrarla:
   `--effort high` ekle (model aynı kalır; raporda "· high" olarak ayrı satır görünür).
5. `node bench/report/build.mjs` çalıştır.
6. Bana şu biçimde kısa bir özet ver:
   - Her koşu için tek satır: kol, puan /80, toplam token, toplam süre, araç çağrısı / hatalı çağrı.
   - Cortex'li ve Cortex'siz koşu arasındaki en büyük üç fark (görev kimliğiyle).
   - Oturum hatası, zaman aşımı ya da MCP bağlantı sorunu olduysa açıkça yaz.
   - Kontrollerin haksız puan verdiğini ya da kestiğini düşündüğün yerleri yaz (görev + kontrol
     etiketi + cevaptan kısa alıntı). Puanı değiştirme; bu not, değerlendirmeyi yapan Claude için.
Ardından seni bu sohbette bekliyor olacağım.
