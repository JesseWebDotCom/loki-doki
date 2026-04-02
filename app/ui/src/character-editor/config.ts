const tokenKey = "lokidoki.token";

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') ||
  (typeof window !== 'undefined' ? window.location.origin : '');

export function getAccessToken() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(tokenKey) || '';
}

export function buildAuthHeaders(headers: Record<string, string> = {}) {
  const token = getAccessToken();
  return token
    ? {
        ...headers,
        Authorization: `Bearer ${token}`,
      }
    : headers;
}
