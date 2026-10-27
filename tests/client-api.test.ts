import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, setCsrf } from '../src/api.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('read requests recover from a non-JSON proxy outage', async () => {
  let calls = 0;
  const network = mock.method(globalThis, 'fetch', async () => ++calls < 3 ? new Response('Bad gateway', { status: 502 }) : json({ healthy: true }));
  try { assert.deepEqual(await api('/api/overview'), { healthy: true }); assert.equal(calls, 3); }
  finally { network.mock.restore(); }
});

test('read requests recover from a temporary network failure', async () => {
  let calls = 0;
  const network = mock.method(globalThis, 'fetch', async () => { if (++calls === 1) throw new TypeError('Failed to fetch'); return json({ healthy: true }); });
  try { assert.deepEqual(await api('/api/overview'), { healthy: true }); assert.equal(calls, 2); }
  finally { network.mock.restore(); }
});

test('a persistent outage stops retrying with a recognizable connection error', async () => {
  const network = mock.method(globalThis, 'fetch', async () => new Response('', { status: 503 }));
  try {
    await assert.rejects(api('/api/overview'), (error: any) => error instanceof ApiError && error.code === 'SERVER_UNAVAILABLE');
    assert.equal(network.mock.callCount(), 4);
  } finally { network.mock.restore(); }
});

test('transfer writes are never repeated after an uncertain network or proxy response', async () => {
  for (const failure of ['network', 'proxy']) {
    setCsrf('test-csrf');
    const network = mock.method(globalThis, 'fetch', async (_path: any, options: any) => {
      assert.equal(options.method, 'POST'); assert.equal(options.headers['x-csrf-token'], 'test-csrf');
      if (failure === 'network') throw new TypeError('Failed to fetch');
      return new Response('Bad gateway', { status: 502 });
    });
    try {
      await assert.rejects(api('/api/transfers', { method: 'POST', body: {} }), (error: any) => error instanceof ApiError && error.code === 'SERVER_UNAVAILABLE' && /Check Transfers/.test(error.message));
      assert.equal(network.mock.callCount(), 1);
    } finally { network.mock.restore(); }
  }
});

test('aborting a read cancels its retry and preserves the abort reason', async () => {
  const controller = new AbortController();
  const network = mock.method(globalThis, 'fetch', async () => { queueMicrotask(() => controller.abort()); throw new TypeError('Failed to fetch'); });
  try {
    await assert.rejects(api('/api/overview', { signal: controller.signal }), (error: any) => error === controller.signal.reason && error.name === 'AbortError');
    assert.equal(network.mock.callCount(), 1);
  } finally { network.mock.restore(); }
});

test('provider errors remain actionable without being retried as server outages', async () => {
  const network = mock.method(globalThis, 'fetch', async () => json({ error: 'Reconnect YouTube Music.', code: 'YOUTUBE_RECONNECT_REQUIRED' }, 409));
  try {
    await assert.rejects(api('/api/connections'), (error: any) => error instanceof ApiError && error.code === 'YOUTUBE_RECONNECT_REQUIRED');
    assert.equal(network.mock.callCount(), 1);
  } finally { network.mock.restore(); }
});

test('expired local sessions reopen before retrying the authorized write', async () => {
  setCsrf('old-csrf'); let calls = 0;
  const network = mock.method(globalThis, 'fetch', async (path: any, options: any) => {
    calls++;
    if (calls === 1) return json({ error: 'Session expired.' }, 401);
    if (calls === 2) { assert.equal(path, '/api/auth/status'); return json({ csrf: 'new-csrf' }); }
    assert.equal(options.headers['x-csrf-token'], 'new-csrf'); return json({ resumed: true });
  });
  try { assert.deepEqual(await api('/api/jobs/existing/resume', { method: 'POST' }), { resumed: true }); assert.equal(calls, 3); }
  finally { network.mock.restore(); }
});
