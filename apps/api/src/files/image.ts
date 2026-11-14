import sharp, { type Metadata } from 'sharp';

export const THUMB_WIDTH = 480;
export const REDUCED_WIDTH = 1600;

/** About 50 megapixels: roomy for a camera photo, far below what a decompression bomb claims. */
export const MAX_PIXELS = 50_000_000;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

const FORMATS: Record<string, { mime: ImageMime; ext: string } | undefined> = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

export class ImageRejected extends Error {
  override readonly name = 'ImageRejected';
  constructor(readonly reason: 'unsupported' | 'too_large') {
    super(reason);
  }
}

export interface DetectedImage {
  mime: ImageMime;
  ext: string;
  width: number;
  height: number;
}

/** Orientations 5 to 8 turn the picture a quarter turn, so the displayed width is the stored height. */
const swapsAxes = (orientation: number | undefined) =>
  orientation !== undefined && orientation >= 5;

/**
 * Decides the type from the bytes. The header is read, not the pixels, so a huge claimed size is
 * refused before anything is decoded.
 */
export async function detectImage(bytes: Buffer): Promise<DetectedImage> {
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch (err) {
    const overLimit = err instanceof Error && /pixel limit/i.test(err.message);
    throw new ImageRejected(overLimit ? 'too_large' : 'unsupported');
  }
  const format = FORMATS[meta.format ?? ''];
  if (!format || !meta.width || !meta.height) throw new ImageRejected('unsupported');
  if (meta.width * meta.height > MAX_PIXELS) throw new ImageRejected('too_large');
  const turned = swapsAxes(meta.orientation);
  return {
    ...format,
    width: turned ? meta.height : meta.width,
    height: turned ? meta.width : meta.height,
  };
}

export interface Variants {
  thumb: Buffer;
  reduced: Buffer;
  width: number;
  height: number;
}

/**
 * Both copies are WebP at the given width, never enlarged. Sharp drops all metadata by default
 * (EXIF, XMP, ICC), so the copies leak nothing. The EXIF orientation is applied first, because
 * once it is gone the picture would otherwise show sideways.
 */
export async function makeVariants(bytes: Buffer): Promise<Variants> {
  const { width, height } = await detectImage(bytes);
  const resized = (target: number) =>
    sharp(bytes, { limitInputPixels: MAX_PIXELS })
      .autoOrient()
      .resize({ width: target, withoutEnlargement: true })
      .webp()
      .toBuffer();
  try {
    const [thumb, reduced] = await Promise.all([resized(THUMB_WIDTH), resized(REDUCED_WIDTH)]);
    return { thumb, reduced, width, height };
  } catch {
    throw new ImageRejected('unsupported');
  }
}
