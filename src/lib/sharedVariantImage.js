/** Plan an explicitly approved family photo for exact, separately verified Positill SKUs. */
export function planSharedVariantImage(sourceCode, sourceFilename, enteredCodes, existingCodes = []) {
  const base = String(sourceCode || '').trim().toUpperCase();
  if (!/^\d{10}$/.test(base)) throw new Error('Choose a photo whose filename starts with a ten-digit family code.');
  const filename = String(sourceFilename || '').trim();
  if (!new RegExp(`^${base}(?:[-_. (].*)?\\.(?:jpe?g|png|webp)$`, 'i').test(filename)) {
    throw new Error('The photo filename does not match this family code.');
  }
  const codes = String(enteredCodes || '').toUpperCase().split(/[\s,;]+/).filter(Boolean);
  if (!codes.length || codes.length > 12) throw new Error('Enter 1–12 exact variant codes.');
  if (new Set(codes).size !== codes.length) throw new Error('Each variant code must appear only once.');
  if (codes.some((code) => !new RegExp(`^${base}[A-Z]$`).test(code))) {
    throw new Error('Each variant must be this ten-digit code plus its exact Positill letter suffix.');
  }
  const existing = new Set(existingCodes.map((code) => String(code || '').trim().toUpperCase()));
  if (codes.some((code) => existing.has(code))) throw new Error('A variant is already in this batch; its image will not be replaced.');
  const ext = filename.split('.').pop().toLowerCase();
  return codes.map((code) => ({ code, filename: `${code}.${ext}` }));
}
