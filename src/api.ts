let csrf = '';
let reopening: Promise<void> | undefined;
export const setCsrf = (value: string) => { csrf = value; };
export class ApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
function pause(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function api<T = any>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}, retried = false): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) { body = JSON.stringify(options.body); headers['Content-Type'] = 'application/json'; }
  if (method !== 'GET') headers['x-csrf-token'] = csrf;
  let response!: Response;
  let data: any;
  const delays = [500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: options.signal });
      data = await response.json();
      break;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (response && !response.ok && response.status < 500) throw new ApiError('Encore returned an unreadable response. Try again.', 'INVALID_RESPONSE');
      if (method !== 'GET' || attempt === delays.length) throw new ApiError(method === 'GET'
        ? 'Connection to Encore was interrupted. Reconnecting…'
        : 'Could not reach Encore. Check Transfers before trying this action again.', 'SERVER_UNAVAILABLE');
      await pause(delays[attempt], options.signal);
    }
  }
  if (!response.ok) {
    if (!retried && response.status === 401 && !path.startsWith('/api/auth/')) {
      reopening ??= api<{ csrf: string }>('/api/auth/status').then(session => setCsrf(session.csrf)).finally(() => { reopening = undefined; });
      await reopening;
      return api<T>(path, options, true);
    }
    throw new ApiError(data?.error || 'The request could not be completed.', data?.code);
  }
  return data;
}
