import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Innertube } from 'youtubei.js';
import { YouTubeAdapter, YouTubeFactory, YouTubeSessionError, ProviderError } from '../server/youtube.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/security.js';
import { createApp } from '../server/app.js';
import { temporaryDirectory } from './helpers.js';

const cookie = 'SAPISID=PRIVATE_COOKIE_VALUE; SID=PRIVATE_SESSION_VALUE';
function sdkFixture() {
  let transport: typeof fetch;
  const selected = { is_selected: true, has_channel: true, channel_handle: '@fixture', account_name: 'Fixture account' };
  const client: any = {
    account: { getInfo: async (all: boolean) => {
      assert.equal(all, true, 'Use the WEB account endpoint for browser-cookie sessions');
      await transport('https://www.youtube.com/youtubei/v1/account/accounts_list');
      return [selected];
    } },
    music: { getLibrary: async () => ({ contents: [], filters: [] }) },
  };
  const sdk = mock.method(Innertube, 'create', async (options: any) => { transport = options.fetch; return client; });
  return { client, sdk };
}

test('HTTP 200 signed-out responses become reconnect errors before the account parser runs', async () => {
  const fixture = sdkFixture();
  const network = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ responseContext: { mainAppWebResponseContext: { loggedOut: true } }, selectText: {} }), { headers: { 'Content-Type': 'application/json' } }));
  try {
    await assert.rejects(() => YouTubeAdapter.connect(cookie), (error: any) => {
      assert.ok(error instanceof YouTubeSessionError); assert.equal(error.status, 401);
      assert.match(error.message, /signed out or expired/); assert.doesNotMatch(error.message, /PRIVATE|Page contents/); return true;
    });
  } finally { network.mock.restore(); fixture.sdk.mock.restore(); }
});

test('a valid session connects, a rejected session is flagged, and reconnect clears the flag', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const vault = new Vault(store);
  const factory = new YouTubeFactory(vault); const fixture = sdkFixture(); let expired = true;
  const network = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ responseContext: { mainAppWebResponseContext: { loggedOut: expired } } }), { headers: { 'Content-Type': 'application/json' } }));
  try {
    vault.set('youtube', { cookie, identity: '@fixture', account: 'Fixture account', accountIndex: 0 });
    await assert.rejects(() => factory.get(), YouTubeSessionError); assert.equal(factory.needsReconnect, true);
    expired = false;
    const provider = await factory.get(); assert.equal(provider.identity, '@fixture'); assert.equal(factory.needsReconnect, false);
    factory.clear(); assert.equal(factory.needsReconnect, false);
  } finally { network.mock.restore(); fixture.sdk.mock.restore(); store.close(); await temp.cleanup(); }
});

test('SDK status-code messages, structured errors, and network failures are categorized without leaking credentials', async () => {
  const errors = [
    { message: 'Request to https://www.youtube.com/youtubei/v1/browse failed with status code 401', expected: 401 },
    { message: 'Request failed', info: { error: { code: 403 } }, expected: 403 },
    { message: 'Request failed', info: JSON.stringify({ error: { code: 429 } }), expected: 429 },
    { name: 'TimeoutError', message: 'PRIVATE_COOKIE_VALUE', expected: 504 },
    { message: 'fetch failed', cause: { code: 'ENOTFOUND' }, expected: 503 },
  ];
  for (const error of errors) {
    const client: any = { music: { search: async () => { throw error; } } };
    await assert.rejects(() => new YouTubeAdapter(client, '@fixture', 'Fixture').search('song', 'Song'), (result: any) => {
      assert.ok(result instanceof ProviderError); assert.equal(result.status, error.expected); assert.doesNotMatch(result.message, /PRIVATE/); return true;
    });
  }
});

test('the API returns a reconnect action for signed-out sessions and reports it in connection status', async () => {
  const temp = await temporaryDirectory(); const fixture = sdkFixture();
  const network = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ responseContext: { mainAppWebResponseContext: { loggedOut: true } } }), { headers: { 'Content-Type': 'application/json' } }));
  const { app, vault } = await createApp({ dataDir: temp.directory, startWorker: false });
  try {
    vault.set('youtube', { cookie, identity: '@fixture', account: 'Fixture', accountIndex: 0 });
    const session = await app.inject({ url: '/api/auth/status' });
    const headers = { cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().csrf };
    const result = await app.inject({ method: 'POST', url: '/api/transfers', headers, payload: { collectionIds: [], likes: true, songs: false, albums: false, artists: false, favoriteIds: [] } });
    assert.equal(result.statusCode, 409); assert.equal(result.json().code, 'YOUTUBE_RECONNECT_REQUIRED');
    assert.match(result.json().error, /Reconnect/); assert.doesNotMatch(result.body, /PRIVATE/);
    const status = await app.inject({ url: '/api/connections', headers }); assert.equal(status.json().youtube.needsReconnect, true);
  } finally { await app.close(); network.mock.restore(); fixture.sdk.mock.restore(); await temp.cleanup(); }
});
