let csrf = '';
let reopening: Promise<void> | undefined;
export const setCsrf = (value: string) => { csrf = value; };
export async function api<T = any>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) { body = JSON.stringify(options.body); headers['Content-Type'] = 'application/json'; }
  if (options.method && options.method !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(path, { method: options.method || 'GET', headers, body, credentials: 'same-origin', signal: options.signal });
  let data: any;
  try { data = await response.json(); }
  catch { throw new Error('The server is unavailable. Make sure Encore is running, then try again.'); }
  if (!response.ok) {
    if (!retried && response.status === 401 && !path.startsWith('/api/auth/')) {
      reopening ??= api<{ csrf: string }>('/api/auth/status').then(session => setCsrf(session.csrf)).finally(() => { reopening = undefined; });
      await reopening;
      return api<T>(path, options, true);
    }
    throw new Error(data.error || 'The request could not be completed.');
  }
  return data;
}
