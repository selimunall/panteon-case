# AI Workflow

Bu projeyi baştan sona Claude Code ile geliştirdim. Burada hangi aracı nasıl kullandığımı, AI'ın nerede işe yaradığını ve hangi kararları kendim verdiğimi olduğu gibi anlatıyorum. Aracım Claude Code (Opus 4.8) oldu. Üstüne **superpowers** diye bir skill çatısı kurdum; bu çatı önce tasarımı konuşmadan koda geçmene izin vermiyor. Yöntemim hep aynıydı: **önce spec, sonra plan, sonra implementasyon.** Her spec `docs/specs/` altında, her plan `docs/plans/` altında duruyor; geçmişe dönüp bakınca hangi kararı neden verdiğimiz orada yazılı.


## Mimari kararlar (en kritik kısım)

Burada AI'ın işi süreci yürütmekti; mimarinin omurgasını ben kurdum.

**Veritabanı rolleri.** *her store tek eksende uzman — Redis = hız, Postgres = doğruluk/para, Mongo = hacim/geçmiş; kimse kimsenin işine girmez.* Redis'i "Postgres'ten yeniden kurulabilen, kaybedilebilir sıcak katman" olarak tanımladım. En kritik kuralı buraya koydum: **okuma istekleri sadece Redis'e dokunur** — 2M aktif kullanıcıda "anında" hissinin tek sebebi bu.

**Yazma yolu.** Hot path'i tek atomik **Lua script** yaptım: idempotency → ZINCRBY → havuz → XADD, tek round-trip. Redis Streams'i "stack'in tek native dayanıklı kuyruğu, tercih değil kısıtın sonucu" diye gerekçelendirdim. Client tarafında 5sn batch + idempotency key + lifecycle
flush + server-side clamp güvenliklerini ben ekledim.

**Okuma yolu.** Scroll'u top 1000 ile tavanladım (keşfin değeri orada biter + derin-scroll DoS'unu keser). Top-100 cache'ini onayladım ama AI'ın atladığı **cache-stampede** riskini yakaladım: düz TTL yerine arka planda her saniye yenileyen bir refresher koydurdum, böylece cache hiç boşalmıyor. Sayfa boyutu 50 + virtualization + prefetch ile eski sistemin "scroll'da donuyor" derdini çözdük.

**Haftalık döngü (para yolu).** havuzu Postgres'ten okumadan önce o haftanın async pipeline'ı tamamen boşalmalı, yoksa eksik parayla dağıtım yaparsın. Araya bir **barrier** koydurdum. Payout sıralamasını da donmuş Redis yerine Postgres'in yetkili toplamlarından türettim. Ödül eğrisini lineer `(101-rank)` tuttum ve "3→4 uçurumu bug değil, podyumda olmak dramatik biçimde daha iyi hissettirmeli" diye savundum. Yuvarlama artığını sonraki haftaya devrettim ki `sum(payouts)+rollover=pool` invariant'ı korunsun.

## Review'larda yakaladığımız gerçek hatalar

- **Durability worker — Mongo idempotency kapısı.** At-least-once teslimatta çift sayımı nasıl engelleyeceğimizi ben tasarladım: önce Mongo'ya `insertMany` (unique idempKey), sadece *yeni giren* event'ler Postgres'e işlenir. AI'ın ilk catch'i *her* hatayı duplicate sayıyordu → Mongo çökse bile event'i ack'leyip kaybederdi; "yalnız E11000'i kısmi-başarı say, gerisini rethrow et" diye düzelttim.

- **Worker — `weeks` satırı boşluğu.** `UPDATE weeks` satır yoksa sessizce no-op oluyordu → `total_earned` hiç birikmezdi. `ensureWeekRow` ekletip worker'ın hafta değişiminde upsert etmesini sağladım.

- **Scheduler sırası.** Biriken haftaları sırasız kapatıyordu → rollover yanlış zincirlenir. `ORDER BY ends_at` (en eski önce) ekledim.

- **Liste staleness'ı (canlı bug).** Tarayıcıda gördüm: liste rank 10, kart rank 11 gösteriyordu. Liste bir kez yüklenip hiç yenilenmiyordu; `usePages`'i her 3sn yüklü rank'leri tazeleyecek şekilde düzelttim.

- **Rank satırı hizalaması (canlı bug).** Skor bir alt satıra kayıyordu — `RankRow`'da 5 çocuk 4-kolon grid'e karşıydı. Rank'ı tek hücreye birleştirip grid'i 4 kolona eşitledim.

- **`.env` boşluğu (canlı çalıştırınca çıktı).** Server env default'suz olduğu için boot'ta çöküyordu; `.env` + Node `--env-file` ile çözdüm.

- **drizzle-kit bigint hatası (canlı çıktı).** `.default(0n)` BigInt literal'ı snapshot'a serialize edilemiyordu; `sql\`0\`` ile düzelttim. Migration üretildi, DESC index'in doğru çıktığını da teyit ettim.


## Özet

AI bu projede çok işime yaradı: süreci disipline etti, her adımda yapılandırılmış seçenekler getirdi, sıkıcı/mekanik kodu hızlı yazdı, görsel iskeleti çıkardı. Ama mimarinin omurgası, para yolunun doğruluğu (barrier, reconcile, rollover invariant), tutarlılık kararları ve canlı
debug'lar benden çıktı.

## AI ile gelişim

AI kullanımı günümüzde çok önemli ama büyük projelerde token tüketimi ciddi bir maliyet. Bunu azaltmak için **Graphiti** gibi bilgi grafiği tabanlı hafıza araçlarıyla proje bağlamını kalıcı tutup her oturumda sadece gerekli kısmı çekmek, context dosyalarını şişirmek yerine skill'lere bölmek ve mekanik işleri subagent'lara devretmek gibi yöntemler kullanılabilir.

