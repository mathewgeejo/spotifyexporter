import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { Worker, createTransfer, reconcilePlaylist } from '../server/worker.js';
import { ProviderError, ReviewRequired } from '../server/youtube.js';
import { FakeMusic, temporaryDirectory } from './helpers.js';

const selection = { collectionIds: [] as string[], likes: true, songs: true, albums: true, artists: true, favoriteIds: [] as string[] };
function resolved(store: Store, kind: 'song' | 'album' | 'artist', name: string, target: string) {
  const id = store.entity({ kind, name, artists: ['Artist'], liked: kind === 'song', saved: kind !== 'artist', followed: kind === 'artist' });
  store.run("UPDATE entities SET status='matched',target=? WHERE id=?", JSON.stringify({ id: target, name, artists: ['Artist'], url: `https://music.youtube.com/browse/${target}` }), id); return id;
}
test('batch playlist transfer preserves repeated songs and performs native likes, saves, and subscriptions', async () => {
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data')); const provider = new FakeMusic(); const worker = new Worker(store, async () => provider);
  try {
    const a = resolved(store, 'song', 'First', 'a'); const b = resolved(store, 'song', 'Second', 'b'); resolved(store, 'album', 'Album', 'album'); resolved(store, 'artist', 'Artist', 'artist');
    const playlist = store.collection('test:playlist', { name: 'A playlist', description: 'Original description' }, [a, b, a]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed'); assert.deepEqual([...provider.playlists.values()][0].ids, ['a', 'b', 'a']);
    assert.equal(provider.calls.appends, 1); assert.equal(provider.likes.size, 2); assert.equal(provider.songs.size, 2); assert.equal(provider.albums.size, 1); assert.equal(provider.artists.size, 1);
    const repeat = createTransfer(store, { ...selection, collectionIds: [playlist] }, provider.identity); await worker.tick();
    assert.equal(store.getJob(repeat.id)!.status, 'completed'); assert.equal(provider.calls.creates, 1); assert.equal(provider.calls.appends, 1); assert.equal(provider.calls.likes, 2);
    assert.equal(store.all('SELECT * FROM steps WHERE job_id=?', job.id).length, job.total);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});
test('lost responses after successful creation and append are reconciled without duplicates', async () => {
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data')); const provider = new FakeMusic(); provider.failAfterCreate = true; provider.failAfterAppend = true;
  const worker = new Worker(store, async () => provider);
  try {
    const song = resolved(store, 'song', 'Song', 'a'); const playlist = store.collection('uncertain', { name: 'Uncertain write', description: '' }, [song, song]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist], likes: false, songs: false }, provider.identity); await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed'); assert.equal(provider.calls.creates, 1); assert.equal(provider.calls.appends, 1); assert.deepEqual([...provider.playlists.values()][0].ids, ['a', 'a']);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});
test('external changes pause a job; authentication failures pause matching and account changes are blocked', async () => {
  assert.throws(() => reconcilePlaylist(['b', 'a'], ['a', 'b'], ['a']), ReviewRequired);
  assert.throws(() => reconcilePlaylist([], ['a', 'b'], ['a']), ReviewRequired);
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data')); const provider = new FakeMusic(); const worker = new Worker(store, async () => provider);
  try {
    const id = store.entity({ kind: 'song', name: 'Song', artists: ['Artist'] }); provider.searchError = new ProviderError('Expired session.', 401);
    const job = store.job('match', {}, [{ kind: 'match', sourceId: id }]); await worker.tick(); assert.equal(store.getJob(job.id)!.status, 'paused');
    provider.searchError = undefined; store.updateJob(job.id, 'queued'); await worker.tick(); assert.equal(store.getJob(job.id)!.status, 'completed');
    const song = resolved(store, 'song', 'Song', 'a'); const transfer = createTransfer(store, { ...selection, likes: true, songs: false, albums: false, artists: false }, '@another-owner');
    await worker.tick(); assert.equal(store.getJob(transfer.id)!.status, 'needs_review'); assert.equal(provider.calls.likes, 0);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});
test('server restart pauses running jobs and skipped sources receive explicit outcomes', async () => {
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data')); const provider = new FakeMusic(); const worker = new Worker(store, async () => provider);
  try {
    const id = store.entity({ kind: 'song', name: 'Local song', artists: ['Artist'], local: true, liked: true }); store.run("UPDATE entities SET status='skipped',reason='Local file.' WHERE id=?", id);
    const job = createTransfer(store, { ...selection, songs: false, albums: false, artists: false }, provider.identity); store.updateJob(job.id, 'running'); worker.start();
    assert.equal(store.getJob(job.id)!.status, 'paused'); store.updateJob(job.id, 'queued'); await worker.tick(); assert.equal(store.getJob(job.id)!.skipped, 1); assert.equal(provider.calls.likes, 0);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});
