import { describe, expect, it } from 'vitest';
import { landedPositillSku, parseLoaderFilename } from '../api/_product-loader-filename.js';

describe('landed Positill filename matching', () => {
  it.each([
    ['8626000775.jpg', '8626000775'],
    ['8626000775-1.jpg', '8626000775'],
    ['8626000775.2.jpg', '8626000775'],
    ['8626000775 (2).jpg', '8626000775'],
    ['8626000775-RED.jpg', '8626000775'],
    ['86260007751-1.jpg', '86260007751-1'],
    ['ABC8626000775.jpg', 'ABC8626000775'],
    ['MKT822662.2.jpg', 'MKT822662.2'],
  ])('%s resolves only an exact leading ten-digit SKU', (filename, expected) => {
    expect(landedPositillSku(parseLoaderFilename(filename))).toBe(expected);
  });
});
