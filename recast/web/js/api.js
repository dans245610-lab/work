// Thin fetch wrapper. All state-changing calls carry X-Requested-With (CSRF guard on the server).
export class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }

export async function api(method, path, body) {
  const opts = { method, headers: { 'X-Requested-With': 'recast' }, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new CustomEvent('recast:unauthorized'));
    throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
  }
  return data;
}
export const GET = (p) => api('GET', p);
export const POST = (p, b = {}) => api('POST', p, b);
export const PUT = (p, b) => api('PUT', p, b);
export const PATCH = (p, b) => api('PATCH', p, b);
export const DEL = (p, b) => api('DELETE', p, b);

/** Raw-body upload with progress (XHR gives upload progress events; fetch does not). */
export function upload(path, file, { headers = {}, onProgress, method = 'PUT' } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.setRequestHeader('X-Requested-With', 'recast');
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'upload'));
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new ApiError(xhr.status, data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    xhr.send(file);
  });
}
