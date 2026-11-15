import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<{ default: (...args: unknown[]) => unknown }>();
  return { default: vi.fn((...args: unknown[]) => actual.default(...args)) };
});

const { detectImage, ImageRejected } = await import('./image.ts');

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>');
const TIFF = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(64)]);
const HEIC = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypheic'),
  Buffer.alloc(32),
]);

describe('magic bytes are checked before sharp', () => {
  beforeEach(() => vi.mocked(sharp).mockClear());

  it.each([
    ['an svg', SVG],
    ['a tiff', TIFF],
    ['a heic', HEIC],
    ['text', Buffer.from('plain text')],
    ['nothing', Buffer.alloc(0)],
  ])('refuses %s without calling sharp', async (_name, bytes) => {
    await expect(detectImage(bytes)).rejects.toBeInstanceOf(ImageRejected);
    expect(sharp).not.toHaveBeenCalled();
  });

  it('lets a real png through to sharp', async () => {
    const real = await vi.importActual<typeof import('sharp')>('sharp');
    const bytes = await real
      .default({ create: { width: 8, height: 8, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    expect((await detectImage(bytes)).mime).toBe('image/png');
    expect(sharp).toHaveBeenCalled();
  });
});
