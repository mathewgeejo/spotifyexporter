import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YouTubeAdapter } from '../server/youtube.js';
import { SpotifyAdapter } from '../server/spotify.js';
import { Store } from '../server/store.js';
import { Vault } from '../server/security.js';
import { temporaryDirectory } from './helpers.js';

test('YouTube adapter uses music-only candidates, explicit private creation, ordered duplicate writes, and native endpoints', async () => {
  const calls: { path: string; args: any }[] = []; let saved = false; let albumSaved = false; let subscribed = false;
  const endpoint = { call: async (_actions: unknown, args: any) => { assert.equal(args.client, 'YTMUSIC'); saved = true; return { success: true }; } };
  const albumEndpoint = { call: async (_actions: unknown, args: any) => { assert.equal(args.client, 'YTMUSIC'); albumSaved = true; return { success: true }; } };
  const client: any = {
    actions: { execute: async (path: string, args: any) => { calls.push({ path, args }); if (path === '/subscription/subscribe') subscribed = true; return { success: true, status_code: 200, data: { playlistId: 'PLtest' } }; } },
    music: {
      search: async () => ({ contents: [{ contents: [
        { item_type: 'video', id: 'video', title: 'Song', artists: [{ name: 'Artist' }] },
        { item_type: 'song', id: 'song', title: 'Song', artists: [{ name: 'Artist' }], duration: { seconds: 180 }, badges: [], menu: { items: [{ icon_type: saved ? 'LIBRARY_REMOVE' : 'LIBRARY_ADD', text: { toString: () => saved ? 'Remove from library' : 'Save to library' }, default_endpoint: endpoint }] } },
      ] }] }),
      getAlbum: async () => ({ header: { buttons: [{ type: 'ToggleButton', icon_type: 'LIBRARY_ADD', text: { toString: () => 'Save to library' }, is_toggled: albumSaved, endpoint: albumEndpoint }] } }),
      getArtist: async () => ({ header: { subscription_button: { type: 'SubscribeButton', channel_id: 'UCactual', subscribed } } }),
      getPlaylist: async () => ({ items: [{ id: 'song' }, { id: 'song' }], has_continuation: false }),
    },
  };
  const adapter = new YouTubeAdapter(client, '@owner', 'Owner');
  const candidates = await adapter.search('song', 'Song Artist'); assert.equal(candidates.length, 1); assert.equal(candidates[0].id, 'song'); assert.equal(candidates[0].durationMs, 180000);
  await adapter.createPlaylist('A playlist', 'Original description'); assert.equal(calls[0].args.privacyStatus, 'PRIVATE'); assert.equal(calls[0].args.description, 'Original description');
  await adapter.append('PLtest', ['song', 'song']); assert.deepEqual(calls[1].args.actions.map((a: any) => a.addedVideoId), ['song', 'song']);
  assert.deepEqual(await adapter.playlistItems('PLtest'), ['song', 'song']);
  await adapter.like('song'); assert.deepEqual(calls[2].args.target, { videoId: 'song' });
  await adapter.saveSong(candidates[0]); await adapter.saveSong(candidates[0]); assert.equal(saved, true);
  await adapter.saveAlbum('MPRalbum'); await adapter.saveAlbum('MPRalbum'); assert.equal(albumSaved, true);
  await adapter.followArtist('UCbrowse'); await adapter.followArtist('UCbrowse'); assert.equal(calls.filter(c => c.path === '/subscription/subscribe').length, 1); assert.deepEqual(calls.at(-1)!.args.channelIds, ['UCactual']);
});
test('Spotify reads every page and marks inaccessible playlists without pretending their contents transferred', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const vault = new Vault(store); const originalFetch = globalThis.fetch; const visited: string[] = [];
  try {
    vault.set('spotify', { access_token: 'token', refresh_token: 'refresh', expires_at: Date.now() + 3600000, account: 'Owner', userId: 'owner' });
    globalThis.fetch = async (input: any) => {
      const url = String(input); visited.push(url);
      let data: any = { items: [], next: null }; let status = 200;
      if (url.includes('/me/playlists?')) data = { items: [{ id: 'owned', name: 'Owned', uri: 'spotify:playlist:owned' }], next: 'https://api.spotify.com/v1/me/playlists?offset=1' };
      if (url.includes('offset=1')) data = { items: [{ id: 'restricted', name: 'Restricted', uri: 'spotify:playlist:restricted' }], next: null };
      if (url.includes('/playlists/owned/items')) data = { items: [{ item: { type: 'track', name: 'Song', artists: [{ name: 'Artist' }], uri: 'spotify:track:one' } }], next: null };
      if (url.includes('/playlists/restricted/items')) status = 403;
      if (url.includes('/me/following')) data = { artists: { items: [], next: null } };
      return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    };
    const job = store.job('spotify_import', {}); await new SpotifyAdapter(store, vault).importAll(job.id, () => {});
    assert.equal(store.collections().length, 2); assert.equal(store.collections().find(c => c.name === 'Owned')!.count, 1); assert.equal(store.collections().find(c => c.name === 'Restricted')!.inaccessible, true);
    assert.equal(visited.some(url => url.includes('offset=1')), true); assert.equal(visited.some(url => url.includes('/me/tracks')), true);
  } finally { globalThis.fetch = originalFetch; store.close(); await temp.cleanup(); }
});
