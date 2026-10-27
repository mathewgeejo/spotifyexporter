import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { Worker, queueTransfer } from '../server/worker.js';
import { chooseMatch } from '../server/matching.js';
import { ProviderError } from '../server/youtube.js';
import { createApp } from '../server/app.js';
import type { Candidate, SourceEntity } from '../shared/types.js';
import { FakeMusic, temporaryDirectory } from './helpers.js';

const selection = { collectionIds: [] as string[], likes: true, songs: false, albums: false, artists: false, favoriteIds: [] as string[] };
const source: SourceEntity = { id: 'source', kind: 'song', name: 'Song', artists: ['Artist'], album: 'Album', durationMs: 180000 };
const candidate: Candidate = { id: 'one', name: 'Song', artists: ['Artist'], album: 'Album', durationMs: 180000, url: 'https://music.youtube.com/watch?v=one' };

test('best recording beats an unrelated first result; ties choose the first available result', () => {
  assert.equal(chooseMatch(source, [{ ...candidate, id: 'wrong', name: 'Other song', artists: ['Other'] }, candidate]).target!.id, 'one');
  assert.equal(chooseMatch(source, [candidate, { ...candidate, id: 'two' }]).target!.id, 'one');
  assert.equal(chooseMatch(source, [{ ...candidate, id: 'live', name: 'Song (Live)' }, candidate]).target!.id, 'one');
  assert.equal(chooseMatch(source, [{ ...candidate, available: false }, { ...candidate, id: 'available' }]).target!.id, 'available');
  assert.equal(chooseMatch(source, []).status, 'skipped');
});

test('1024 existing review candidates are accepted immediately without additional catalog searches', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory);
  try {
    const ids = store.transaction(() => Array.from({ length: 1024 }, (_, index) => {
      const name = `Track ${index}`;
      const id = store.entity({ kind: 'song', name, artists: ['Artist'], uri: `spotify:track:${index}` });
      const candidates = [
        { id: `wrong-${index}`, name: 'Unrelated recording', artists: ['Other'], url: 'https://music.youtube.com/watch?v=wrong' },
        { id: `best-${index}`, name, artists: ['Artist'], url: `https://music.youtube.com/watch?v=best-${index}` },
      ];
      store.run("UPDATE entities SET status='review',candidates=? WHERE id=?", JSON.stringify(candidates), id); return id;
    }));
    const playlist = store.collection('backlog', { name: '1024 songs', description: '' }, [...ids, ids[0]]);
    const job = queueTransfer(store, { ...selection, collectionIds: [playlist], likes: false }, '@owner');
    assert.equal(job.kind, 'transfer');
    assert.equal(store.get("SELECT COUNT(*) n FROM entities WHERE status='matched'")!.n, 1024);
    const payload = JSON.parse(store.get('SELECT payload FROM jobs WHERE id=?', job.id)!.payload);
    assert.deepEqual(payload.sequences[playlist], [...ids.map((_, index) => `best-${index}`), 'best-0']);
    assert.equal(job.total, 1026);
  } finally { store.close(); await temp.cleanup(); }
});

test('Start transfer searches pending songs, skips no-results, preserves the snapshot, and queues one transfer', async () => {
  const temp = await temporaryDirectory(); const provider = new FakeMusic(); const searched: string[] = [];
  provider.search = async (_kind, query) => {
    searched.push(query);
    return query.includes('Missing') ? [] : [{ ...candidate, id: 'best' }, { ...candidate, id: 'tied' }];
  };
  const { app, store, worker } = await createApp({ dataDir: temp.directory, providerFactory: async () => provider, startWorker: false });
  try {
    const song = store.entity({ kind: 'song', name: 'Song', artists: ['Artist'], liked: true });
    const missing = store.entity({ kind: 'song', name: 'Missing', artists: ['Artist'] });
    const skip = store.entity({ kind: 'song', name: 'Skip me', artists: ['Artist'] });
    store.run("UPDATE entities SET status='skipped',reason='Skipped by owner.' WHERE id=?", skip);
    const playlist = store.collection('auto', { name: 'Automatic', description: '' }, [song, missing, song, skip]);
    const session = await app.inject({ url: '/api/auth/status' });
    const headers = { cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().csrf };
    const response = await app.inject({ method: 'POST', url: '/api/transfers', headers, payload: { ...selection, collectionIds: [playlist] } });
    assert.equal(response.statusCode, 200, response.body);
    const queued = response.json(); assert.equal(queued.kind, 'match');
    store.collection('auto', { name: 'Changed after queuing', description: '' }, [missing]);
    await worker.tick(); assert.equal(store.getJob(queued.id)!.status, 'completed_with_issues');
    assert.equal(store.getEntity(song)!.target!.id, 'best'); assert.equal(store.getEntity(missing)!.matchStatus, 'skipped');
    assert.equal(searched.length, 2); assert.equal(searched.some(query => query.includes('Skip me')), false);
    const transfer = store.get("SELECT id FROM jobs WHERE kind='transfer'")!;
    store.run('UPDATE jobs SET created=? WHERE id=?', '9999-01-01', transfer.id);
    store.updateJob(queued.id, 'queued'); await worker.tick();
    assert.equal(store.get("SELECT COUNT(*) n FROM jobs WHERE kind='transfer'")!.n, 1);
    await worker.tick(); assert.equal(store.getJob(transfer.id)!.status, 'completed_with_issues');
    assert.deepEqual([...provider.playlists.values()][0].ids, ['best', 'best']);
    assert.equal([...provider.playlists.values()][0].name, 'Automatic'); assert.equal(provider.calls.likes, 1);
    const report = await app.inject({ url: `/api/jobs/${transfer.id}/report`, headers });
    assert.equal(report.statusCode, 200); assert.equal(report.json().items.filter((item: any) => item.status === 'skipped').length, 2);
  } finally { await app.close(); await temp.cleanup(); }
});

test('an expired session pauses automatic matching without creating a transfer until reconnection', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory); const provider = new FakeMusic();
  const worker = new Worker(store, async () => provider);
  try {
    store.entity({ kind: 'song', name: 'Song', artists: ['Artist'], liked: true });
    provider.searchError = new ProviderError('Expired session.', 401);
    const job = queueTransfer(store, selection, provider.identity);
    await worker.tick(); assert.equal(store.getJob(job.id)!.status, 'paused');
    assert.equal(store.get("SELECT COUNT(*) n FROM jobs WHERE kind='transfer'")!.n, 0);
    provider.searchError = undefined; store.updateJob(job.id, 'queued'); await worker.tick(); await worker.tick();
    assert.equal(provider.calls.likes, 1);
  } finally { await worker.stop(); store.close(); await temp.cleanup(); }
});
