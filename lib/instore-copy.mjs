export const INSTORE_COPY_LIMITS = Object.freeze({ title: 300, description: 2000 });

export function normalizeInstoreCopy(copy) {
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw new Error('Website wording is required.');
  const result = {};
  for (const field of ['title', 'description']) {
    if (typeof copy[field] !== 'string') throw new Error(`Website ${field === 'title' ? 'name' : field} must be text.`);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/u.test(copy[field])) throw new Error('Use plain text for website wording, not HTML.');
    const value = copy[field].normalize('NFC').replace(/\r\n?/g, '\n').trim().toUpperCase();
    result[field] = field === 'title' ? value.replace(/\s+/g, ' ') : value;
    if (!result[field]) throw new Error(`Website ${field === 'title' ? 'name' : field} cannot be blank.`);
    if (result[field].length > INSTORE_COPY_LIMITS[field]) throw new Error(`Website ${field === 'title' ? 'name' : field} must be ${INSTORE_COPY_LIMITS[field]} characters or fewer.`);
  }
  return result;
}

export function instoreCopyError(copy) {
  try { normalizeInstoreCopy(copy); return ''; } catch (error) { return error.message; }
}
