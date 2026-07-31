// Client-side receipt-photo compression. Browser-only (canvas), so no unit
// tests — verify on the real phone like the PDF import machinery.
//
// Why compress at all: an iPhone camera photo is 3–8 MB HEIC→JPEG; a receipt
// is legible at ~1600 px long edge / JPEG 0.8 ≈ 150–400 KB, which keeps the
// free Supabase Storage tier (1 GB) good for thousands of receipts and makes
// display loads instant on cellular. Re-encoding through a canvas also strips
// EXIF — including GPS — as a side effect worth having on a financial doc.
//
// iOS notes: the file input deliberately does NOT list image/heic — when heic
// isn't accepted, iOS transcodes to JPEG itself before handing the File over
// (listing it hands you a real HEIC that canvas can't decode on other
// browsers). createImageBitmap exists on iOS 15+, but decode via an <img> +
// object URL works everywhere, so that's the only path.

const MAX_EDGE = 1600;
const QUALITY = 0.8;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't read that image"));
    img.src = url;
  });
}

// file → { blob, mime }. Always emits JPEG (transparency is meaningless on a
// receipt photo, and JPEG is the small option). Throws with a user-facing
// message on undecodable input; callers surface it, never swallow it.
export async function compressReceipt(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error("Couldn't read that image");
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    // A JPEG has no alpha: paint white first so a transparent PNG doesn't
    // come out black.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', QUALITY),
    );
    // toBlob can return null (canvas too large, out of memory). If the
    // original is already a small web-safe image, ship it as-is rather than
    // failing the capture.
    if (!blob) {
      if ((file.type === 'image/jpeg' || file.type === 'image/png') && file.size <= 4 * 1024 * 1024) {
        return { blob: file, mime: file.type };
      }
      throw new Error("Couldn't process that image on this device");
    }
    return { blob, mime: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}
