# evplan — kiralık ev için ölçülü mobilya yerleşimi

Evi gerçek ölçüleriyle (duvar, kapı, pencere, petek, kolon, tezgâh…) çizer, mobilyaları
gerçek **G × D × Y** ölçüleriyle yerleştirmenizi ve içinde yürümenizi sağlar. Her değişiklikte
"**sığar mı?**" sorusunu cevaplar:

| Kontrol | Nasıl | Sonuç |
| --- | --- | --- |
| Çakışma | Döndürülmüş kutular arası ayırma ekseni testi (SAT), **yükseklik dahil** (peteğin üstündeki raf çakışmaz) | kırmızı |
| Ev dışı | Mobilyanın 4 köşesi bir odanın içinde mi | kırmızı |
| Kapı açılması | Kapı kanadı 0° → 90° süpürülür, ilk çarptığı açı raporlanır ("en fazla 62° açılıyor") | kırmızı |
| Pencere kanadı | Aynı süpürme, ama yalnızca denizlik üstü yükseklikte (alçak mobilya engel değil) | turuncu |
| Kapı önü | Kapı boşluğunun iki yanındaki 40 cm'de mobilya net geçişi daraltıyor mu | turuncu/kırmızı |
| Dolap kapağı / çekmece | Mobilyanın kendi kapakları ve çekmeceleri tam açılıyor mu | kırmızı |
| Kullanım alanı | Yatak yanı, masa önü, gardırop önü vb. için önerilen boşluk var mı (cm cinsinden "60 önerilir, 35 var") | turuncu |
| Geçiş yolu | 2 cm'lik zemin ızgarası + öklid mesafe dönüşümü; girişten her kapıya giden **en geniş** yol ve en dar noktası | <60 kırmızı, <75 turuncu |
| Teslimat | Mobilyanın en küçük iki ölçüsü giriş kapısından (ve ölçüsü girilirse asansörden) geçiyor mu (yaklaşık) | turuncu |

Geçiş analizi kapı kasalarını "yapısal" sayar: 70 cm'lik banyo kapısı kendi başına uyarı üretmez;
mobilyanın yarattığı daralma ise ayrıca raporlanır. Evin kendi yapısından gelen darlık mavi "bilgi"
olarak gösterilir. Eşikler `plan.json → settings` içindedir.

## Çalıştırma

```bash
cd evplan
npm ci            # ilk sefer
npm run dev       # http://localhost:5173 — aynı Wi-Fi'daki telefondan: http://<bilgisayar-ip>:5173
npm test          # çekirdek hesap testleri
npm run check     # tüm yerleşimleri komut satırında kontrol et (--veri demo)
npm run import -- <model.json> <klasör>   # oda-poligonu modelini plan.json'a çevir
node scripts/build-artifact.mjs ev <klasör> "Başlık"   # veri gömülü tek sayfalık önizleme (build sonrası)
npm run build     # dist/ (statik site; GitHub Pages'e konabilir)
```

Not: npm 10.9'daki bir hata yüzünden `npm install` (kilit dosyası yeniden çözümlenirken) çökebilir;
`npm ci` sorunsuzdur. Paket eklemek gerekirse `npx npm@11 install <paket>` kullanın.

## Kullanım

- **Plan** (kuşbakışı, duvarlar 120 cm'den kesilmiş mimari plan gibi) · **3D** (dış bakış) · **Yürü** (göz hizası 160 cm).
- Mobilyaya dokunun → seçilir; sürükleyin → taşınır (duvara/mobilyaya 6 cm'den yakınsa yapışır, Alt ile kapatılır).
- Döndürme: üstteki çubuk (⟲90 ⟲15 ⟳15 ⟳90), telefonda **ikinci parmakla çevirme**, klavyede R / Q / E.
- Seçili mobilyanın dört kenarından en yakın engele mesafe (cm) planda çizilir.
- Yürü: masaüstünde WASD/oklar + sürükleyerek bakış; telefonda sol yarı joystick, sağ yarı bakış. Duvar ve mobilyalardan geçilmez. Sağ altta mini plan; **mini plana dokununca oraya geçilir** (koridor ölçülmediyse odalar arası).
- **Mezura** (Ölç): iki noktaya dokun → mesafe. Planda yatay (x × y bileşenleriyle), 3D'de gerçek mesafe.
- **Katalog**: türlere göre (koltuk, TV ünitesi, televizyon, masa…) ürün kartları. "Ekle" görünümün ortasına (yürürken
  önünüze) koyar; aynı türden bir mobilya daha önce kullanıldıysa **son bırakıldığı yere** (arka kenarı hizalı) gelir.
  Seçili mobilya varken "Yerine dene" ve çubuktaki ◀ ▶ aynı türün ürünlerini sırayla aynı yerde dener; üstündeki TV
  yeni üniteye taşınır.
- **Gizle** (çubukta ya da H): mobilya çizilmez ve kontrollere girmez; sol üstteki "N gizli · göster" geri getirir.
  Sağdaki **TV** düğmesi tüm televizyonları birlikte gizler/gösterir. **Sil** (Del) her modda çalışır; Ctrl+Z geri alır.
- Üstte duran eşyalar (TV): yüksekliği altındaki üniteye göre otomatik; ayaklardan biri boşta kalırsa ya da
  üst tablanın taşıma sınırı (`maxTopLoad`) aşılırsa hata verilir.
- Yerleşimler: kopyala, yeniden adlandır, JSON indir/yükle, **paylaşım linki** (yerleşim linkin içinde, sunucu gerekmez), **karşılaştırma tablosu** ve başka bir yerleşimi **hayalet** olarak üstüne çizme.

Tarayıcıda yaptığınız değişiklikler o tarayıcıda (localStorage) saklanır. Kalıcı yapmak için
"JSON indir" → dosyayı `public/data/layouts/` içine koyup `index.json`'a ekleyin. Dosya sonradan
değişirse dosya kazanır; tarayıcıdaki değişiklikler "(yerel kopya)" adıyla ayrı yerleşim olarak kalır.

## Veri dosyaları (kod değiştirmeden düzenlenir)

```
public/data/
  furniture.json         ortak mobilya kataloğu (ölçü, renk, link, isteğe bağlı GLB modeli)
  ev/                    GERÇEK EV — depo herkese açık olduğu için .gitignore'da (onay bekliyor)
    plan.json            içe aktarılan plan (aşağıya bakın)
    layouts/…            yerleşimler
    source/model.json    kaynak model (metre)
  demo/                  örnek 2+1 daire (ölçüler varsayım)
    plan.json, layouts/…
public/models/           GLB modelleri (isteğe bağlı)
public/splats/           Gaussian splat (.spz) — 3. aşama
```

Uygulama `data/ev/` varsa onu, yoksa demoyu açar; `?veri=demo` ile demo zorlanır. Bir veri setinde
`furniture.json` varsa ortak katalog yerine o kullanılır.

### Oda-poligonu modelinden içe aktarma

Metre cinsinden, odaları iç yüz poligonu + kenar bazlı açıklık/petek/ankastre olarak tanımlayan model
(Claude'daki görüntüleyicinin `…-model.json` dosyası) doğrudan çevrilir:

```bash
npm run import -- public/data/ev/source/model.json public/data/ev
```

Dönüşüm kuralları: duvarlar her odanın dışına `wall_thickness_assumed` kalınlıkta çizilir, ama komşu odaya
taşmaz (boşluk küçükse inceltilir ve not düşülür). Camlar kanatlara bölünür: açılan kanatlar camlı kapı
(içe açıldığı ve menteşe tarafı **tahmin**), sabitler pencere. Koridor/antre ölçülmemişse odaların koridora
açılan kapıları "giriş" sayılır; geçiş analizi her birinden başlar. Tavan kirişi, sarkıt lambalar ve ankastre
dolaplar yükseklikleriyle sabit engel olur (üst dolap/kiriş planda kesik çizgi).

Hatalı bir alan olursa uygulama açılışta Türkçe hata listesi gösterir (ör. "openings[3] (K-banyo):
duvar I-koridor-alt 900 cm; açıklık 880–950 cm aralığı duvarın dışına taşıyor").

### Koordinatlar

Birim **cm**. `x` sağa, `y` **aşağı** (plan resmi gibi). Yükseklik `z` yerden yukarı. Açılar derece,
ekranda **saat yönünde**. Mobilyada `rot: 0` iken mobilyanın **önü aşağı (+y)** bakar.

```
(0,0) ──────────► x
  │   ┌──────────────┐
  │   │   mobilya    │   rot = 0  → ön yüz aşağıda
  │   └──────────────┘
  ▼ y       ön
```

### `plan.json`

```jsonc
{
  "meta": { "name": "…", "demo": false },
  "settings": { "ceilingHeight": 260, "eyeHeight": 160, "passageMin": 75, "passageHard": 60, "accessMin": 60, "gridStep": 2 },
  "walls": [
    // from→to çizgisi; thickness bu çizginin hangi tarafına? side: left | right | center
    // ("left" = from'dan to'ya yürürken sol el). Dış duvarlarda çizgiyi İÇ YÜZE koyup kalınlığı dışa vermek
    // şerit metre ölçüleriyle birebir eşleşir.
    { "id": "D-kuzey", "from": [0, 0], "to": [900, 0], "thickness": 25, "side": "left" },
    { "id": "B-kuzey", "from": [40, -165], "to": [340, -165], "thickness": 15, "side": "left", "height": 110 } // korkuluk
  ],
  "openings": [
    // offset: duvarın from ucundan açıklığın başlangıcına (cm), width: NET geçiş genişliği (kasa içi)
    // hinge: menteşe start/end tarafında; swing: kanadın açıldığı taraf (left/right, duvar yönüne göre)
    { "id": "K-salon", "type": "door", "wall": "I-salon-koridor", "offset": 400, "width": 80, "height": 205, "hinge": "end", "swing": "left" },
    // leafWidth (kanat genişliği, varsayılan width/leaves), openAngle (varsayılan 90), entrance: true (giriş kapısı)
    { "id": "P-salon", "type": "window", "wall": "D-kuzey", "offset": 200, "width": 180, "sill": 90, "height": 150, "leaves": 2, "swing": "right", "pivotInset": 8 }
    // pencerede swing yoksa kanat kontrolü yapılmaz (sabit/vasistas); pivotInset: menteşenin duvar yüzünden içeride olduğu mesafe
  ],
  "rooms": [ { "id": "salon", "name": "Salon", "polygon": [[0,0],[520,0],[520,400],[0,400]], "floor": "parke" } ],
  "fixtures": [
    // sabit engeller: radiator, column, counter, boiler, shower, wc, sink … (x,y merkez; z yerden yükseklik)
    { "id": "petek-salon", "type": "radiator", "name": "Petek", "x": 290, "y": 9, "w": 140, "d": 10, "h": 60, "z": 15 }
  ],
  "access": { "entranceDoor": "K-giris", "elevator": null },
  "splat": null
}
```

Oda çokgenleri **iç yüzlerdir** (Magicplan'ın ve şerit metrenin verdiği ölçüler). Duvar uçları
birbirine değiyorsa köşe boşlukları otomatik kapatılır.

### `furniture.json`

```jsonc
{ "items": [
  {
    "id": "kanepe-3", "name": "3'lü kanepe", "category": "Salon",
    "w": 220, "d": 95, "h": 85,          // G × D × Y (cm)
    "color": "#5f7387",
    "url": "https://…",                   // ürün linki
    "model": "models/kanepe.glb",         // isteğe bağlı; kutu yerine çizilir, G×D×Y'ye ölçeklenir
    "modelRotation": 0,                   // model önü +z'ye bakmıyorsa düzeltme (derece)
    "use": { "front": 40 },               // kullanım alanı (front/back/left/right, cm); "sideFrom": 0.4 → yanlar ayak tarafında
    "frontDoors": { "count": 4 },         // menteşeli kapaklar (hinge: left/right; çok kapakta otomatik)
    "drawers": { "depth": 35 },           // çekmece çekilme derinliği
    "movable": true,                      // sandalye gibi: masanın altına girebilir, geçişi kapatmaz
    "collides": false,                    // halı gibi: çakışma sayılmaz
    "flatpack": true,                     // demonte gelir → kapı/asansör kontrolü yapılmaz
    "onTop": true,                        // TV gibi: altındaki mobilyanın üstüne oturur (z otomatik)
    "weight": 15.5, "maxTopLoad": 40,     // kg: eşyanın ağırlığı / üst tablanın taşıyabileceği
    "group": "Televizyon",                // katalog türü ("Yerine dene" ve son konum bu türe göre)
    "assumed": true                       // ölçü örnek/varsayım
  }
]}
```

### `layouts/*.json`

```json
{ "id": "a-klasik", "name": "A – Klasik",
  "items": [ { "uid": "a1", "ref": "kanepe-3", "x": 200, "y": 210, "rot": 270 } ] }
```

`x, y` mobilyanın taban **merkezi**. Bir yerleşimde katalog ölçüsünü ezmek için `w, d, h, z, color, name, use`
eklenebilir; `"choice": {"Kumaş": "Sisli Yeşil"}` ürün seçeneğini, `"hidden": true` gizli olduğunu tutar. Katalogda olmayan bir kutu için `ref` yerine doğrudan `name, w, d, h` verilebilir.

## Yol haritası

| Aşama | Durum |
| --- | --- |
| 1. MVP: plan + ölçülerden 3D ev, kutu mobilyalar, Plan / 3D / Yürü, sığar mı kontrolleri | ✅ (demo 2+1 ile) |
| 2. Katalog JSON + GLB bağlama | ✅ altyapı hazır (henüz GLB yok) |
| 3. Marble `.spz` splat'ını arka plan yap, 2–3 bilinen ölçüyle ölçek + hizalama kalibrasyonu (Spark 2.x) | ⏳ dosya bekleniyor |
| 4. Telefonda açmak için yayın (GitHub Pages / Actions) | ⏳ karar bekleniyor (aşağıya bakın) |

## Teknik kararlar

- **three.js 0.186** (MIT) + **Vite 8**; çerçeve yok (düz JS). Saf hesap çekirdeği (`src/core/`) DOM'dan
  bağımsızdır: hem tarayıcıda hem Node testlerinde ve komut satırında aynı kod çalışır.
- Ağır geçiş analizi **Web Worker**'da çalışır; telefonda sürükleme takılmaz. Sürüklerken hızlı kontroller,
  bırakınca tam analiz.
- Splat için **Spark** (`@sparkjsdev/spark`, MIT, World Labs) planlanıyor: `.spz` doğrudan destekli, three.js
  sahnesine `SplatMesh` olarak girer; mobilya kutuları ve kontroller aynı sahnede kalır.

## Kaynaklar ve lisanslar

- [three.js](https://github.com/mrdoob/three.js) — MIT. Kullanılıyor.
- [sparkjsdev/spark](https://github.com/sparkjsdev/spark) — MIT. 3. aşamada kullanılacak.
- [dohun1214/roomlens](https://github.com/dohun1214/roomlens) — depoda **lisans dosyası yok** (varsayılan: tüm
  hakları saklı). **Kod alınmadı**; yalnızca yaklaşım fikirleri (SAT çakışması, ızgarada geçiş, kapı önü,
  pencere önü ve "kullanım tarafı" kontrolleri, X ekseninde ters dönen splat'lar için düzeltme seçeneği) ilham oldu.
  Buradaki geçiş analizi farklı bir yöntemle (mesafe dönüşümü + en geniş yol) yazıldı.
- [Gaet9/house-scan](https://github.com/Gaet9/house-scan) — lisans dosyası yok (README "kullanabilirsiniz" diyor ama
  resmi lisans değil). Kod alınmadı; CUDA GPU gerektiren COLMAP + Brush hattı burada gerekmiyor (Marble kullanılıyor).
  README'deki çekim önerileri (göğüs hizası, %70 örtüşme, kapılardan iki yönde geçiş) yürüyüş videosu için de geçerli.
