let _cache = null;

export async function fetchPopupSpecial() {
  if (_cache) return _cache;
  const res = await fetch('/api/popup-special');
  const data = await res.json();
  _cache = data;
  return data;
}

export async function savePopupSpecial(payload) {
  _cache = null;
  const res = await fetch('/api/popup-special', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to save popup special');
  _cache = json;
  return json;
}

export async function uploadPopupImage(file) {
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const res = await fetch('/api/upload-popup-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType: file.type, base64 }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Failed to upload popup image');
  return json;
}
