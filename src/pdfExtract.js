// pdf.js loader + text-run extraction (browser side).
//
// Kept in its own module so the parsing core (src/pdfImport.js) stays pure and
// testable in Node: this file is the ONLY place that touches pdf.js.
//
// pdfjs-dist is ~1MB, so it is loaded with a dynamic import the first time a
// PDF is actually opened — it never lands in the main bundle. The worker is
// bundled by Vite via `?url` (a local asset), so nothing is fetched from a CDN:
// the import works offline and under a strict CSP, same as the rest of the app.

let pdfjsPromise = null;

function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    // The LEGACY build, deliberately. pdf.js's modern bundle calls very new JS
    // (e.g. Map.prototype.getOrInsertComputed) that current Chromium and iOS
    // Safari don't have yet — it throws "getOrInsertComputed is not a function"
    // on a real device. The legacy bundle is transpiled for the browsers this
    // app actually runs in, including the iPhone PWA.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Vite resolves this to a bundled asset URL at build time.
    const workerUrl = (await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  })();
  return pdfjsPromise;
}

// ArrayBuffer → { pageCount, pages: [{ page, width, height, runs }] } where each
// run is { str, x, y, w, h } in top-left origin CSS-ish coordinates (y grows
// downward), which is what the template editor renders and the parser reasons
// about. `hasTextLayer` is false for scanned/image-only PDFs — those can't be
// parsed without OCR and the UI says so instead of silently importing nothing.
export async function extractPdfPages(data, { maxPages = 60 } = {}) {
  const pdfjs = await loadPdfjs();
  // pdf.js transfers/detaches the buffer it is given; copy so the caller's
  // ArrayBuffer stays usable (the user may re-parse with a different template).
  const bytes = new Uint8Array(data.slice ? data.slice(0) : data);
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;

  const pages = [];
  const count = Math.min(doc.numPages, maxPages);
  for (let p = 1; p <= count; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const runs = [];
    for (const item of content.items) {
      const str = item.str;
      if (!str || !str.trim()) continue;
      // transform = [a,b,c,d,e,f]; e/f are the x/y translation with a
      // bottom-left origin. Flip y so the editor can position runs directly.
      const x = item.transform[4];
      const yBottom = item.transform[5];
      const h = item.height || Math.abs(item.transform[3]) || 10;
      runs.push({
        str,
        x,
        y: viewport.height - yBottom - h,
        w: item.width || 0,
        h,
      });
    }
    pages.push({ page: p, width: viewport.width, height: viewport.height, runs });
  }

  const hasTextLayer = pages.some(pg => pg.runs.length > 0);
  return { pageCount: doc.numPages, pages, hasTextLayer, truncated: doc.numPages > count };
}
