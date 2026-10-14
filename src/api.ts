let csrf = '';
export const setCsrf = (value: string) => { csrf = value; };
export async function api<T = any>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) { body = JSON.stringify(options.body); headers['Content-Type'] = 'application/json'; }
  if (options.method && options.method !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(path, { method: options.method || 'GET', headers, body, credentials: 'same-origin', signal: options.signal });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('encore-session-expired'));
    throw new Error(data.error || 'The request could not be completed.');
  }
  return data;
}
