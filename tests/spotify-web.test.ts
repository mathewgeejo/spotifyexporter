import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { spotifyCookie, spotifyTotp, queryHashes, playerConfig, SpotifyWebClient, webSong } from '../server/spotify-web.js';
import { ProviderError } from '../server/youtube.js';
import { FakeMusic, temporaryDirectory } from './helpers.js';

const sessionCookie = 'sp_dc=TEST_SPOTIFY_SESSION_1234567890';
const operations = ['profileAttributes', 'libraryV3', 'fetchPlaylist', 'fetchLibraryTracks'];
const bundle = operations.map((name, i) => `new Query("${name}","query","${String(i).repeat(64)}",null)`).join(';');
const song = (name: string, uri = `spotify:track:${name}`) => ({ __typename: 'Track', name, uri,
  artists: { items: [{ profile: { name: 'Artist' } }] }, albumOfTrack: { name: 'Album' }, duration: { totalMilliseconds: 180000 }, contentRating: { label: 'EXPLICIT' } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

function spotifyFixture(handle: (name: string, variables: any) => any) {
  const calls: { name: string; variables: any }[] = []; let authorizations = 0;
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://open.spotify.com/') {
      assert.equal(new Headers(init?.headers).get('cookie'), sessionCookie);
      return new Response(`<script id="appServerConfig" type="text/plain">${Buffer.from(JSON.stringify({ clientVersion: '1.3.8.test', serverTime: 1793000000 })).toString('base64')}</script><script src="https://open.spotifycdn.com/cdn/build/web-player/web-player.test.js"></script>`);
    }
    if (url.includes('open.spotifycdn.com/')) {
      assert.equal(new Headers(init?.headers).get('cookie'), null, 'Never forward the account cookie to the CDN'); return new Response(bundle);
    }
    if (url.includes('secretDict.json')) return json({ 99: Array.from({ length: 26 }, (_, i) => i + 30) });
    if (url === 'https://open.spotify.com/api/server-time') return json({ serverTime: 1793000000 });
    if (url.includes('/api/token?')) {
      authorizations++; assert.equal(new URL(url).searchParams.get('totpVer'), '99');
      return json({ accessToken: `access-${authorizations}`, clientId: 'client', isAnonymous: false, accessTokenExpirationTimestampMs: Date.now() + 3600000 });
    }
    if (url.includes('clienttoken.spotify.com')) return json({ granted_token: { token: 'client-token', expires_after_seconds: 3600 } });
    assert.equal(url, 'https://api-partner.spotify.com/pathfinder/v2/query');
    const headers = new Headers(init?.headers); assert.equal(headers.get('client-token'), 'client-token'); assert.equal(headers.get('cookie'), null);
    const body = JSON.parse(String(init?.body)); assert.equal(body.extensions.persistedQuery.sha256Hash, queryHashes(bundle)[body.operationName]);
    calls.push({ name: body.operationName, variables: body.variables });
    const data = handle(body.operationName, body.variables);
    return data instanceof Response ? data : json({ data });
  };
  return { request, calls, authorizations: () => authorizations };
}

test('web-player metadata, rotated query hashes, cookies, and recording metadata are parsed without executing scripts', () => {
  assert.equal(spotifyCookie('TEST_SPOTIFY_SESSION_1234567890'), sessionCookie);
  assert.equal(spotifyCookie('TEST_SPOTIFY_SESSION_1234567890=='), `${sessionCookie}==`);
  assert.equal(spotifyCookie(`Cookie: sp_t=device; ${sessionCookie}; unrelated=secret`), sessionCookie);
  assert.throws(() => spotifyCookie('sp_t=not_a_session'), ProviderError);
  assert.throws(() => spotifyCookie('sp_dc=bad\nheader'), ProviderError);
  assert.throws(() => playerConfig('<html>Provider changed</html>'), ProviderError);
  assert.equal(Object.keys(queryHashes(bundle)).length, 4);
  const parsed = webSong({ itemV2: { data: song('Song') } })!;
  assert.deepEqual(parsed.artists, ['Artist']); assert.equal(parsed.durationMs, 180000); assert.equal(parsed.explicit, true);
  const currentTrack = { ...song('Current player track'), duration: undefined, trackDuration: { totalMilliseconds: 214800 } };
  assert.equal(webSong({ itemV2: { data: currentTrack } })!.durationMs, 214800);
  assert.equal(webSong({ itemV2: { data: { __typename: 'Episode', name: 'Podcast' } } }), undefined);
  // RFC 6238's SHA-1 test vector at t=59, transformed back to Spotify's public cipher format.
  const cipher = [...'12345678901234567890'].map((n, i) => Number(n) ^ ((i % 33) + 9));
  assert.equal(spotifyTotp(cipher, 59), '287082');
});

test('free-account connection → all library pages → matching → private YouTube playlist and native likes', async () => {
  const fixture = spotifyFixture((name, variables) => {
    if (name === 'profileAttributes') return { me: { profile: { username: 'free-owner', name: 'Free Spotify owner' } } };
    if (name === 'libraryV3') {
      assert.equal(variables.flatten, true, 'Include playlists inside folders');
      return { me: { libraryV3: { totalCount: 2, items: variables.offset === 0 ? [
        { item: { data: { __typename: 'Playlist', uri: 'spotify:playlist:list', name: 'My playlist' } } },
      ] : [{ item: { data: { __typename: 'Album', uri: 'spotify:album:album', name: 'Album', artists: { items: [{ profile: { name: 'Artist' } }] } } } }] } } };
    }
    if (name === 'fetchPlaylist') return { playlistV2: { __typename: 'Playlist', name: 'My playlist', uri: 'spotify:playlist:list', description: 'From Spotify Free', content: {
      totalCount: 3, items: variables.offset === 0 ? [{ itemV2: { data: song('Song') } }, { itemV2: { data: song('Second') } }] : [{ itemV2: { data: song('Song') } }],
    } } };
    if (name === 'fetchLibraryTracks') return { me: { library: { tracks: { totalCount: 2, items: variables.offset === 0
      ? [{ track: { data: song('Song') } }] : [{ track: { data: song('Second') } }],
    } } } };
    throw new Error(`Unexpected operation ${name}`);
  });
  const original = globalThis.fetch; globalThis.fetch = fixture.request;
  const temp = await temporaryDirectory(); const provider = new FakeMusic();
  const { app, store, worker, vault } = await createApp({ dataDir: temp.directory, providerFactory: async () => provider, startWorker: false });
  try {
    const session = await app.inject({ url: '/api/auth/status' });
    const headers = { cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().csrf };
    const connected = await app.inject({ method: 'POST', url: '/api/connections/spotify', headers, payload: { cookie: sessionCookie } });
    assert.equal(connected.statusCode, 200, connected.body); assert.equal(connected.json().mode, 'web');
    assert.doesNotMatch(store.setting('secret:spotify')!, /TEST_SPOTIFY_SESSION/);
    const status = await app.inject({ url: '/api/connections', headers }); assert.equal(status.json().spotify.account, 'Free Spotify owner'); assert.doesNotMatch(status.body, /TEST_SPOTIFY_SESSION|access-/);
    const imported = await app.inject({ method: 'POST', url: '/api/imports/spotify', headers }); assert.equal(imported.statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/imports/spotify', headers })).statusCode, 409);
    await worker.tick(); assert.equal(store.getJob(imported.json().id)!.status, 'completed', store.getJob(imported.json().id)!.message);
    assert.equal(store.collections().length, 1); const playlist = store.collections()[0]; assert.equal(playlist.count, 3);
    const entries = store.all('SELECT entity_id FROM entries WHERE collection_id=? ORDER BY position', playlist.id);
    assert.equal(entries[0].entity_id, entries[2].entity_id); assert.equal(store.all("SELECT * FROM entities WHERE json_extract(body,'$.liked')=1").length, 2);
    assert.deepEqual(fixture.calls.filter(c => c.name === 'fetchLibraryTracks').map(c => c.variables.offset), [0, 1]);
    assert.deepEqual(fixture.calls.filter(c => c.name === 'libraryV3').map(c => c.variables.offset), [0, 1]);
    const selection = { collectionIds: [playlist.id], likes: true, songs: false, albums: false, artists: false, favoriteIds: [] };
    const matching = await app.inject({ method: 'POST', url: '/api/matches', headers, payload: selection }); assert.equal(matching.statusCode, 200);
    await worker.tick(); assert.equal(store.getJob(matching.json().id)!.status, 'completed');
    // This source is deliberately ambiguous in the fake catalog: exercise the actual review endpoint.
    const pending = store.all("SELECT * FROM entities WHERE kind='song' AND status!='matched'");
    for (const entity of pending) {
      const candidates = JSON.parse(entity.candidates); assert.ok(candidates.length);
      const review = await app.inject({ method: 'PATCH', url: `/api/matches/${entity.id}`, headers, payload: { action: 'approve', candidateId: candidates[0].id } }); assert.equal(review.statusCode, 200);
    }
    const transfer = await app.inject({ method: 'POST', url: '/api/transfers', headers, payload: selection }); assert.equal(transfer.statusCode, 200, transfer.body);
    await worker.tick(); assert.equal(store.getJob(transfer.json().id)!.status, 'completed');
    assert.equal(provider.calls.creates, 1); assert.equal([...provider.playlists.values()][0].ids.length, 3); assert.equal(provider.calls.likes, 2);
    const repeated = await app.inject({ method: 'POST', url: '/api/imports/spotify', headers }); await worker.tick();
    assert.equal(store.getJob(repeated.json().id)!.status, 'completed'); assert.equal(store.collections().length, 1); assert.equal(store.collections()[0].count, 3);
    vault.remove('spotify');
  } finally { globalThis.fetch = original; await app.close(); await temp.cleanup(); }
});

test('browser connector refreshes an expired token once and rejects incomplete pagination', async () => {
  let expired = false;
  const fixture = spotifyFixture((name, variables) => {
    if (name === 'profileAttributes' && !expired) { expired = true; return json({ error: 'Expired' }, 401); }
    if (name === 'profileAttributes') return { me: { profile: { username: 'owner' } } };
    return { me: { libraryV3: { totalCount: 3, items: variables.offset === 0 ? [{ item: {} }] : [] } } };
  });
  const client = new SpotifyWebClient(sessionCookie, fixture.request);
  assert.equal((await client.profile()).userId, 'owner'); assert.equal(fixture.authorizations(), 2);
  await assert.rejects(async () => { for await (const page of client.pages('libraryV3', {}, data => data.me.libraryV3, () => {})) void page; }, /incomplete collection/);
});

test('expired client tokens are refreshed and a repeated Spotify page cannot duplicate an import', async () => {
  let rejectedClient = false;
  const fixture = spotifyFixture(() => {
    if (!rejectedClient) {
      rejectedClient = true;
      return new Response('{}', { status: 400, headers: { 'Content-Type': 'application/json', 'client-token-error': 'INVALID_CLIENTTOKEN' } });
    }
    return { me: { libraryV3: { totalCount: 2, pagingInfo: { offset: 0 }, items: [{ item: {} }] } } };
  });
  const client = new SpotifyWebClient(sessionCookie, fixture.request);
  await assert.rejects(async () => { for await (const page of client.pages('libraryV3', {}, data => data.me.libraryV3, () => {})) void page; }, /repeated or out-of-order page/);
  assert.equal(fixture.authorizations(), 2);
});

test('a failed later playlist page preserves the previous complete snapshot and account changes need review', async () => {
  const fixture = spotifyFixture((name, variables) => {
    if (name === 'profileAttributes') return { me: { profile: { username: 'owner' } } };
    if (name === 'libraryV3') return { me: { libraryV3: { totalCount: 1, items: [{ item: { data: { __typename: 'Playlist', name: 'List', uri: 'spotify:playlist:list' } } }] } } };
    if (name === 'fetchPlaylist') return variables.offset === 0 ? { playlistV2: { __typename: 'Playlist', uri: 'spotify:playlist:list', content: { totalCount: 2, items: [{ itemV2: { data: song('New') } }] } } } : json({}, 403);
    throw new Error(`Unexpected query ${name}`);
  });
  const original = globalThis.fetch; globalThis.fetch = fixture.request; const temp = await temporaryDirectory();
  const { app, store, vault, worker } = await createApp({ dataDir: temp.directory, startWorker: false });
  try {
    vault.set('spotify', { mode: 'web', cookie: sessionCookie, userId: 'owner', account: 'Owner' });
    const old = store.entity({ kind: 'song', name: 'Original', artists: ['Artist'] });
    const id = store.collection('spotify:owner:list', { name: 'List', description: '' }, [old]);
    const job = store.job('spotify_import', { userId: 'owner' }); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'paused'); assert.equal(store.collections()[0].count, 1);
    assert.equal(store.all('SELECT entity_id FROM entries WHERE collection_id=?', id)[0].entity_id, old);
    assert.equal(store.get("SELECT id FROM entities WHERE name='New'"), undefined);
    const wrongAccount = store.job('spotify_import', { userId: 'someone-else' }); await worker.tick(); assert.equal(store.getJob(wrongAccount.id)!.status, 'needs_review');
  } finally { globalThis.fetch = original; await app.close(); await temp.cleanup(); }
});
