// Halı desen haritaları (shape.map, ör. "textures/montis-etiam-907011.png"; yol data/ klasörüne göre).
// Ürün görselinden çıkarılmış ~1 cm/piksel, paletli küçük PNG'ler. Uygulama açılırken bir kez yüklenir;
// böylece model, küçük görsel ve Foto modu haritayı beklemeden (eşzamanlı) kullanır.

export const rugImages = new Map();

/** Katalogdaki tüm desen haritalarını yükler; yüklenemeyen harita atlanır (halı düz renk görünür). */
export function preloadRugMaps(catalog, base = './data/', timeout = 6000) {
  const paths = new Set((catalog.items ?? []).map((c) => c.shape?.map).filter(Boolean));
  const jobs = [...paths].map(
    (p) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          rugImages.set(p, img);
          resolve();
        };
        img.onerror = () => resolve();
        img.src = base + p;
      }),
  );
  return Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeout))]);
}
