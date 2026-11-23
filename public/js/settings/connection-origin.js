export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';

export function connectionOrigin(value, defaultUrl = '') {
  const raw = (typeof value === 'string' ? value.trim() : '') || defaultUrl;
  try {
    const url = new URL(raw);
    if (url.host && /^[a-z][\w+.-]*:\/\//i.test(raw)) return (url.protocol + '//' + url.host).toLowerCase();
  } catch { /* 地址可能还没填完整，保守地比较整串 */ }
  return raw;
}
