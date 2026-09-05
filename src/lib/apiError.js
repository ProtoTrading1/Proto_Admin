/** Normalize API `{ error }` payloads for toast display. */
export function errorFromJson(json, fallback = 'Request failed') {
  if (!json) return fallback;
  if (typeof json === 'string') return json;
  if (typeof json.error === 'string') return json.error;
  if (json.error && typeof json.error.message === 'string') return json.error.message;
  if (typeof json.message === 'string') return json.message;
  return fallback;
}

export async function readApiJson(res, { fallback } = {}) {
  const fb = fallback || `Server error (${res.status})`;
  const text = await res.text().catch(() => '');
  let json = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      const hint = text.slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new Error(hint && !hint.startsWith('{')
        ? `${fb}${hint ? ` — ${hint}` : ''}`
        : (fb || 'Server returned invalid JSON'));
    }
  }
  if (!res.ok) {
    throw new Error(errorFromJson(json, fb));
  }
  return json;
}
