import { describe, it, expect, vi, afterEach } from 'vitest';
import { imageCanvasDimensions, prepareProductManagerImage, PRODUCT_IMAGE_MAX_BYTES } from '../src/lib/productImageUpload.js';
import { compressImage, uploadDormantImage } from '../src/lib/products.js';

describe('Product Manager high-resolution uploads', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(['MI001-3', 'MI035-2', 'MI127-1'])('preserves optimized %s JPEG bytes without recompression', async (code) => {
    const file = { name: `${code}.jpg`, type: 'image/jpeg', size: 200_000 };
    const compress = vi.fn();
    expect(await prepareProductManagerImage(file, compress)).toEqual({ file, filename: file.name, contentType: file.type });
    expect(compress).not.toHaveBeenCalled();
  });
  it.each([['image/png','png'],['image/webp','webp']])('preserves %s content type and matching extension', async (type, ext) => {
    const file = { name: 'photo.dat', type, size: 10_000 };
    expect(await prepareProductManagerImage(file, vi.fn())).toEqual({ file, filename: `photo.${ext}`, contentType: type });
  });
  it('resizes oversized inputs to 1600px with original aspect ratio', async () => {
    const file = { name:'photo.png', type:'image/png', size:PRODUCT_IMAGE_MAX_BYTES + 1 };
    const output = { size:200_000 };
    const compress = vi.fn().mockResolvedValue(output);
    expect(await prepareProductManagerImage(file, compress)).toEqual({ file:output, filename:'photo.jpg', contentType:'image/jpeg' });
    expect(compress).toHaveBeenCalledWith(file, { size:1600, square:false });
    expect(imageCanvasDimensions(3000,4000,{size:1600,square:false})).toEqual({width:1200,height:1600,w:1200,h:1600,offsetX:0,offsetY:0});
    expect(imageCanvasDimensions(4000,3000,{size:1600,square:false}).width).toBe(1600);
    expect(imageCanvasDimensions(400,300,{size:1600,square:false}).width).toBe(400);
  });
  it('retains the legacy 800px square compression for bulk/loader callers', () => {
    expect(imageCanvasDimensions(1200,1600)).toEqual({width:800,height:800,w:600,h:800,offsetX:100,offsetY:0});
  });
  it('retains conversion for other browser-decodable formats', async () => {
    const file = {size:200,type:'image/gif',name:'photo.gif'};
    const output = {size:100};
    expect(await prepareProductManagerImage(file, vi.fn().mockResolvedValue(output))).toEqual({file:output, filename:'photo.jpg',contentType:'image/jpeg'});
  });
  it('rejects empty and still-oversized uploads before transmission', async () => {
    await expect(prepareProductManagerImage({size:0}, vi.fn())).rejects.toThrow('empty');
    await expect(prepareProductManagerImage({size:2_000_000,type:'image/jpeg',name:'x.jpg'}, vi.fn().mockResolvedValue({size:2_000_000}))).rejects.toThrow('too large');
  });
  it('uploads the exact optimized file and its matching content type', async () => {
    const file = {name:'MI001-3.png',type:'image/png',size:200_000};
    const read = vi.fn();
    vi.stubGlobal('FileReader', class {
      readAsDataURL(input) { read(input); this.result = 'data:image/png;base64,YXBwcm92ZWQ='; this.onload(); }
    });
    const fetchMock = vi.fn().mockResolvedValue({ok:true,text:async()=>JSON.stringify({url:'https://example.test/image.png'})});
    vi.stubGlobal('fetch',fetchMock);
    expect(await uploadDormantImage(file)).toBe('https://example.test/image.png');
    expect(read).toHaveBeenCalledWith(file);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/upload-product-image');
    expect(JSON.parse(options.body)).toEqual({filename:'MI001-3.png',contentType:'image/png',base64:'YXBwcm92ZWQ='});
  });
  it('renders the oversized fallback at 1200x1600 rather than 800-square', async () => {
    const ctx = {fillRect:vi.fn(),drawImage:vi.fn()};
    const blob = {size:200_000};
    const canvas = {getContext:()=>ctx,toBlob:callback=>callback(blob)};
    vi.stubGlobal('document',{createElement:()=>canvas});
    const revoke = vi.fn();
    vi.stubGlobal('URL',{createObjectURL:()=> 'blob:test',revokeObjectURL:revoke});
    vi.stubGlobal('Image',class {width=3000; height=4000; set src(_value){this.onload();}});
    expect(await compressImage({},{size:1600,square:false})).toBe(blob);
    expect([canvas.width,canvas.height]).toEqual([1200,1600]);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(),0,0,1200,1600);
    expect(revoke).toHaveBeenCalledWith('blob:test');
  });
});
