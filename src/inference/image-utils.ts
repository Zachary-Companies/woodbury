/**
 * Image Utilities for Visual AI Inference
 *
 * Base64 decode, region cropping, and letterbox preprocessing.
 * Port of the Python helpers in woobury_models.serve (decode_image, crop_region)
 * and woobury_models.model (letterbox).
 */

import sharp from 'sharp';

// ── Constants ────────────────────────────────────────────────────

export const MAX_SIDE = 224;
export const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
export const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

export interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ── Base64 Decode ────────────────────────────────────────────────

/**
 * Decode a base64-encoded image string to a raw Buffer.
 * Handles both data URL format ("data:image/png;base64,...") and raw base64.
 */
export function decodeBase64Image(data: string): Buffer {
  let b64 = data;
  if (b64.startsWith('data:')) {
    // Strip data URL prefix: data:image/png;base64,...
    const commaIdx = b64.indexOf(',');
    if (commaIdx !== -1) {
      b64 = b64.slice(commaIdx + 1);
    }
  }
  return Buffer.from(b64, 'base64');
}

// ── Region Crop ──────────────────────────────────────────────────

/**
 * Crop a region from an image using pixel bounds.
 * Clamps to image boundaries. Returns the full image if bounds are too small.
 *
 * Port of Python: crop_region(img, bounds)
 */
export async function cropRegion(imageBuffer: Buffer, bounds: Bounds): Promise<Buffer> {
  const metadata = await sharp(imageBuffer).metadata();
  const imgW = metadata.width ?? 0;
  const imgH = metadata.height ?? 0;

  const left = Math.max(0, Math.round(bounds.left));
  const top = Math.max(0, Math.round(bounds.top));
  const right = Math.min(imgW, left + Math.round(bounds.width));
  const bottom = Math.min(imgH, top + Math.round(bounds.height));

  const width = right - left;
  const height = bottom - top;

  // Bounds too small — return full image (matches Python behavior)
  if (width < 2 || height < 2) {
    return imageBuffer;
  }

  return sharp(imageBuffer)
    .extract({ left, top, width, height })
    .toBuffer();
}

// ── Letterbox + Preprocess ───────────────────────────────────────

/**
 * Letterbox an image to MAX_SIDE × MAX_SIDE, then normalize to a
 * (1, 3, 224, 224) Float32Array ready for ONNX inference.
 *
 * Pipeline (matches Python exactly):
 *   1. Resize preserving aspect ratio (long side = 224, bilinear)
 *   2. Paste centered on black 224×224 canvas
 *   3. Convert to float32, divide by 255
 *   4. Subtract ImageNet mean, divide by ImageNet std
 *   5. Transpose HWC → CHW, add batch dimension → (1, 3, 224, 224)
 *
 * Port of Python: ElementMatcher._preprocess(img)
 */
export async function preprocessImage(imageBuffer: Buffer): Promise<Float32Array> {
  // Get original dimensions
  const metadata = await sharp(imageBuffer).metadata();
  const w = metadata.width ?? 1;
  const h = metadata.height ?? 1;

  // 1. Letterbox: resize preserving aspect ratio
  const scale = MAX_SIDE / Math.max(w, h);
  const newW = Math.round(w * scale);
  const newH = Math.round(h * scale);

  // Use int() truncation to match Python's int(w * scale)
  const pyNewW = Math.trunc(w * scale);
  const pyNewH = Math.trunc(h * scale);

  const resized = await sharp(imageBuffer)
    .removeAlpha()
    .resize(pyNewW, pyNewH, { fit: 'fill', kernel: 'lanczos3' })
    .toFormat('png')
    .toBuffer();

  // 2. Paste centered on black canvas (matches Python's Image.new + paste)
  const pasteX = Math.trunc((MAX_SIDE - pyNewW) / 2);
  const pasteY = Math.trunc((MAX_SIDE - pyNewH) / 2);

  const rawPixels = await sharp({
    create: {
      width: MAX_SIDE,
      height: MAX_SIDE,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: resized, left: pasteX, top: pasteY }])
    .removeAlpha()
    .raw()
    .toBuffer();

  // 3-5. Normalize + transpose HWC → CHW
  const pixels = MAX_SIDE * MAX_SIDE;
  const floats = new Float32Array(3 * pixels);

  for (let c = 0; c < 3; c++) {
    const mean = IMAGENET_MEAN[c];
    const std = IMAGENET_STD[c];
    const channelOffset = c * pixels;

    for (let i = 0; i < pixels; i++) {
      // Raw buffer is HWC interleaved: [R, G, B, R, G, B, ...]
      const srcIdx = i * 3 + c;
      floats[channelOffset + i] = (rawPixels[srcIdx] / 255.0 - mean) / std;
    }
  }

  return floats;
}
