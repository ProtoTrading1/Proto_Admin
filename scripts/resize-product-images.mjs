import fs from 'node:fs/promises';
import path from 'node:path';
import { Jimp, HorizontalAlign, VerticalAlign, cssColorToHex } from 'jimp';

const [, , inputDir = 'input-images', outputDir = 'output-images'] = process.argv;
const SIZE = 800;
const ALLOWED = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function listImages(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => ALLOWED.has(path.extname(name).toLowerCase()));
}

async function resizeOne(inputPath, outputPath) {
  const image = await Jimp.read(inputPath);
  image.contain({
    w: SIZE,
    h: SIZE,
    align: HorizontalAlign.CENTER | VerticalAlign.MIDDLE,
    background: cssColorToHex('#ffffffff'),
  });
  await image.quality?.(92);
  await image.write(outputPath);
}

async function main() {
  const absInput = path.resolve(inputDir);
  const absOutput = path.resolve(outputDir);
  await ensureDir(absOutput);
  const files = await listImages(absInput);

  if (!files.length) {
    console.log(`No images found in ${absInput}`);
    process.exit(0);
  }

  for (const file of files) {
    const inputPath = path.join(absInput, file);
    const outputPath = path.join(absOutput, `${path.parse(file).name}-800x800.jpg`);
    await resizeOne(inputPath, outputPath);
    console.log(`Resized ${file} -> ${outputPath}`);
  }

  console.log(`Done. ${files.length} image(s) resized to ${SIZE}x${SIZE}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
