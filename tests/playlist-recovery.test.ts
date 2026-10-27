import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { createTransfer, Worker } from '../server/worker.js';
import { YouTubeAdapter, PlaylistWriteRejected, ProviderError } from '../server/youtube.js';
import { FakeMusic, temporaryDirectory } from './helpers.js';

const selection = { collectionIds: [] as string[], likes: false, songs: false, albums: false, artists: false, favoriteIds: [] as string[] };
function matched(store: Store, name: string, video: string, flags = {}) {
  const id = store.entity({ kind: 'song', name, artists: ['Artist'], ...flags });
  store.run("UPDATE entities SET status='matched',target=? WHERE id=?", JSON.stringify({ id: video, name, artists: ['Artist'], url: `https://music.youtube.com/watch?v=${video}` }), id);
  return id;
}

test('a repeated recording across the second batch does not reject a 120-song transfer', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); let ids: string[] = []; let appends = 0;
  const client: any = {
    actions: { execute: async (path: string, body: any) => {
      if (path === '/playlist/create') return { success: true, data: { playlistId: 'playlist' } };
      assert.equal(path, '/browse/edit_playlist'); appends++;
      // YouTube's real behavior: reject the entire batch on an existing recording,
      // unless each action explicitly skips the duplicate check.
      if (body.actions.some((action: any) => ids.includes(action.addedVideoId) && action.dedupeOption !== 'DEDUPE_OPTION_SKIP')) return { success: true, status_code: 200, data: { status: 'STATUS_FAILED' } };
      ids.push(...body.actions.map((action: any) => action.addedVideoId));
      return { success: true, data: { status: 'STATUS_SUCCEEDED' } };
    } },
    music: { getPlaylist: async () => ({ items: ids.map(id => ({ id })), has_continuation: false }) },
  };
  const provider = new YouTubeAdapter(client, '@owner', 'Owner'); const worker = new Worker(store, async () => provider);
  try {
    const desired = Array.from({ length: 120 }, (_, index) => `video-${index === 70 ? 20 : index}`);
    const entities = desired.map((video, index) => matched(store, `Song ${index}`, video));
    const playlist = store.collection('repeated-recording', { name: 'My playlist', description: '' }, entities);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed', store.getJob(job.id)!.message);
    assert.equal(store.getJob(job.id)!.done, 121); assert.equal(appends, 3); assert.deepEqual(ids, desired);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});

test('an HTTP 200 failed playlist status is rejected rather than treated as a successful append', async () => {
  const client: any = { actions: { execute: async () => ({ success: true, status_code: 200, data: { status: 'STATUS_FAILED' } }) } };
  await assert.rejects(() => new YouTubeAdapter(client, '@owner', 'Owner').append('playlist', ['video']), (error: any) => error instanceof ProviderError && error.status === 502);
});

test('delayed playlist reads are polled without appending the same songs again', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const provider = new FakeMusic();
  const read = provider.playlistItems.bind(provider); const append = provider.append.bind(provider);
  let stale: string[] = []; let reads = 0;
  provider.append = async (id, ids) => { stale = await read(id); await append(id, ids); reads = 2; };
  provider.playlistItems = async id => reads-- > 0 ? [...stale] : read(id);
  const worker = new Worker(store, async () => provider);
  try {
    const song = matched(store, 'Song', 'video'); const playlist = store.collection('delayed', { name: 'Delayed reads', description: '' }, [song, song]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed'); assert.equal(provider.calls.appends, 1);
    assert.deepEqual([...provider.playlists.values()][0].ids, ['video', 'video']);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});

test('real unexpected destination edits still pause without overwriting or further appends', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const provider = new FakeMusic();
  const append = provider.append.bind(provider);
  provider.append = async (id, ids) => { await append(id, ids); provider.playlists.get(id)!.ids.unshift('external-song'); };
  const worker = new Worker(store, async () => provider);
  (worker as any).wait = async () => {};
  try {
    const song = matched(store, 'Song', 'video'); const playlist = store.collection('external', { name: 'External edit', description: '' }, [song]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'needs_review'); assert.equal(provider.calls.appends, 1);
    assert.deepEqual([...provider.playlists.values()][0].ids, ['external-song', 'video']);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});

test('a lost append response followed by stale reads never sends that batch again', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const provider = new FakeMusic();
  const read = provider.playlistItems.bind(provider); const append = provider.append.bind(provider); let staleReads = 0;
  provider.append = async (id, ids) => { await append(id, ids); staleReads = 5; throw new ProviderError('Response was lost.', 502); };
  provider.playlistItems = async id => staleReads-- > 0 ? [] : read(id);
  const worker = new Worker(store, async () => provider); (worker as any).wait = async () => {};
  try {
    const song = matched(store, 'Repeated song', 'video'); const playlist = store.collection('lost-stale', { name: 'Lost response', description: '' }, [song, song]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed'); assert.equal(provider.calls.appends, 1);
    assert.deepEqual([...provider.playlists.values()][0].ids, ['video', 'video']);
    assert.equal(store.all("SELECT * FROM settings WHERE key LIKE 'playlist-append:%'").length, 0);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});

test('unconfirmed appends wait automatically and survive a server restart without duplication', async () => {
  const temp = await temporaryDirectory(); let store = new Store(temp.directory); const provider = new FakeMusic();
  const read = provider.playlistItems.bind(provider); let stale = true; let reads = 0;
  provider.playlistItems = async id => { reads++; return stale ? [] : read(id); };
  let worker = new Worker(store, async () => provider); (worker as any).wait = async () => {};
  try {
    const song = matched(store, 'Song', 'video'); const playlist = store.collection('restart-stale', { name: 'Restart while waiting', description: '' }, [song]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'queued'); assert.match(store.getJob(job.id)!.message, /automatically/);
    assert.equal(provider.calls.appends, 1); assert.equal(store.getJob(job.id)!.done, 1);
    assert.equal(store.all("SELECT * FROM settings WHERE key LIKE 'playlist-append:%'").length, 1);
    const before = reads; await worker.tick(); assert.equal(reads, before, 'Respect the scheduled confirmation check');
    await worker.stop(); store.close(); store = new Store(temp.directory);
    worker = new Worker(store, async () => provider); (worker as any).wait = async () => {};
    worker.start(); store.run("UPDATE jobs SET payload=json_set(payload,'$.nextCheck',0) WHERE id=?", job.id); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'queued'); assert.equal(provider.calls.appends, 1);
    stale = false; store.run("UPDATE jobs SET payload=json_set(payload,'$.nextCheck',0) WHERE id=?", job.id); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed'); assert.equal(provider.calls.appends, 1);
    assert.deepEqual([...provider.playlists.values()][0].ids, ['video']);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});

test('a transient read older than the confirmed checkpoint is reread before any append', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const provider = new FakeMusic();
  const read = provider.playlistItems.bind(provider); let sawFirstBatch = false; let oldReads = 0;
  provider.playlistItems = async id => {
    const actual = await read(id);
    if (actual.length === 50 && !sawFirstBatch) { sawFirstBatch = true; oldReads = 3; return actual; }
    if (oldReads-- > 0) return [];
    return actual;
  };
  const worker = new Worker(store, async () => provider); (worker as any).wait = async () => {};
  try {
    const songs = Array.from({ length: 51 }, (_, index) => matched(store, `Song ${index}`, `video-${index}`));
    const playlist = store.collection('old-checkpoint', { name: 'Stale read', description: '' }, songs);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed'); assert.equal(provider.calls.appends, 2);
    assert.deepEqual([...provider.playlists.values()][0].ids, songs.map((_, index) => `video-${index}`));
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});

test('an explicitly rejected append can retry after clearing its unsent intent', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const provider = new FakeMusic();
  const append = provider.append.bind(provider); let attempts = 0;
  provider.append = async (id, ids) => { if (++attempts === 1) throw new PlaylistWriteRejected('Rejected.', 502); await append(id, ids); };
  const worker = new Worker(store, async () => provider); (worker as any).wait = async () => {};
  try {
    const song = matched(store, 'Song', 'video'); const playlist = store.collection('rejected', { name: 'Rejected write', description: '' }, [song]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed'); assert.equal(attempts, 2); assert.equal(provider.calls.appends, 1);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});

test('existing saved jobs expose source counts separately from playlist/like/save actions', async () => {
  const temp = await temporaryDirectory(); let store = new Store(temp.directory);
  try {
    const song = matched(store, 'Song', 'video', { liked: true, saved: true });
    const playlist = store.collection('counts', { name: 'Count repeated items', description: '' }, [song, song]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist], likes: true, songs: true }, '@owner');
    assert.equal(job.total, 5); assert.equal(job.summary!.sourceItems, 1); assert.equal(job.summary!.playlistEntries, 2);
    const payload = JSON.parse(store.get('SELECT payload FROM jobs WHERE id=?', job.id)!.payload); delete payload.summary;
    store.run('UPDATE jobs SET payload=? WHERE id=?', JSON.stringify(payload), job.id);
    store.close(); store = new Store(temp.directory);
    assert.deepEqual(store.getJob(job.id)!.summary, { sourceItems: 1, playlists: 1, playlistEntries: 2, likes: 1, savedSongs: 1, albums: 0, artists: 0 });
  } finally { store.close(); await temp.cleanup(); }
});
