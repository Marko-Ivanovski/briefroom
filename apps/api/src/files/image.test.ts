import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { pngClaiming } from '../../test/image-fixtures.ts';
import { detectImage, ImageRejected, makeVariants, MAX_PIXELS } from './image.ts';

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#3366cc' } });

const png = (width: number, height: number) => solid(width, height).png().toBuffer();

const dims = async (bytes: Buffer) => {
  const { width, height, format } = await sharp(bytes).metadata();
  return { width, height, format };
};

describe('makeVariants', () => {
  it('makes a 480 wide thumb and a 1600 wide reduced copy of a 3000x2000 png', async () => {
    const out = await makeVariants(await png(3000, 2000));
    expect(out.width).toBe(3000);
    expect(out.height).toBe(2000);
    expect(await dims(out.thumb)).toEqual({ width: 480, height: 320, format: 'webp' });
    expect(await dims(out.reduced)).toEqual({ width: 1600, height: 1067, format: 'webp' });
  });

  it('never enlarges a small image', async () => {
    const out = await makeVariants(await png(300, 200));
    expect((await dims(out.thumb)).width).toBe(300);
    expect((await dims(out.reduced)).width).toBe(300);
  });

  it('keeps a transparent png transparent', async () => {
    const bytes = await sharp({
      create: { width: 600, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();
    const { thumb } = await makeVariants(bytes);
    expect((await sharp(thumb).metadata()).hasAlpha).toBe(true);
  });

  it('carries no EXIF, XMP or colour profile into either copy (R117)', async () => {
    const source = await solid(1200, 800)
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret owner', ImageDescription: 'secret place' } })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><secret/></x:xmpmeta>')
      .withIccProfile('p3')
      .toBuffer();
    const before = await sharp(source).metadata();
    expect(before.exif).toBeDefined();
    expect(before.xmp).toBeDefined();
    expect(before.icc).toBeDefined();

    const { thumb, reduced } = await makeVariants(source);
    for (const variant of [thumb, reduced]) {
      const meta = await sharp(variant).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(variant.includes(Buffer.from('secret'))).toBe(false);
    }
  });

  it('applies the EXIF orientation before the metadata is dropped', async () => {
    const source = await solid(600, 400).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const out = await makeVariants(source);
    expect(out.width).toBe(400);
    expect(out.height).toBe(600);
    expect(await dims(out.thumb)).toMatchObject({ width: 400, height: 600 });
  });

  it('refuses an image over the pixel limit before decoding it', async () => {
    const bomb = pngClaiming(20_000, 20_000);
    expect(20_000 * 20_000).toBeGreaterThan(MAX_PIXELS);
    await expect(makeVariants(bomb)).rejects.toMatchObject({
      name: 'ImageRejected',
      reason: 'too_large',
    });
  });
});

describe('detectImage', () => {
  it('reads the type from the bytes', async () => {
    expect(await detectImage(await png(40, 30))).toMatchObject({
      mime: 'image/png',
      ext: 'png',
      width: 40,
      height: 30,
    });
    expect((await detectImage(await solid(40, 30).jpeg().toBuffer())).mime).toBe('image/jpeg');
    expect((await detectImage(await solid(40, 30).webp().toBuffer())).mime).toBe('image/webp');
  });

  it('rejects text, empty input and unsupported image formats', async () => {
    for (const bytes of [
      Buffer.from('hello, this is not a picture'),
      Buffer.alloc(0),
      await solid(40, 30).gif().toBuffer(),
      await solid(40, 30).tiff().toBuffer(),
    ]) {
      await expect(detectImage(bytes)).rejects.toBeInstanceOf(ImageRejected);
      await expect(detectImage(bytes)).rejects.toMatchObject({ reason: 'unsupported' });
    }
  });

  it('rejects an svg, which could carry script', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(detectImage(svg)).rejects.toMatchObject({ reason: 'unsupported' });
  });
});
