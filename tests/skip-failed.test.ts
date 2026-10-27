import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { createTransfer } from '../server/worker.js';
import { skipFailedTransferSteps } from '../server/job-actions.js';
import { Store } from '../server/store.js';
import { ProviderError } from '../server/youtube.js';
import { FakeMusic, temporaryDirectory } from './helpers.js';

const selection = { collectionIds: [] as string[], likes: false, songs: false, albums: false, artists: false, favoriteIds: [] as string[] };
function song(store: Store, name: string) {
  const id = store.entity({ kind: 'song', name, artists: ['Artist'], liked: true, saved: true });
  store.run("UPDATE entities SET status='matched',target=? WHERE id=?", JSON.stringify({ id: name, name, artists: ['Artist'], url: `https://music.youtube.com/watch?v=${name}` }), id);
  return id;
}

test('skip failed creation skips its tracks and continues other playlists, likes, and saves through the API', async () => {
  const temp = await temporaryDirectory(); const provider = new FakeMusic();
  const create = provider.createPlaylist.bind(provider);
  provider.createPlaylist = async (name, description) => { if (name === 'Broken') throw new ProviderError('Playlist creation rejected.', 400); return create(name, description); };
  const { app, store, worker } = await createApp({ dataDir: temp.directory, providerFactory: async () => provider, startWorker: false });
  (worker as any).wait = async () => {};
  try {
    const first = song(store, 'First'); const second = song(store, 'Second');
    const broken = store.collection('broken', { name: 'Broken', description: '' }, [first, second]);
    const good = store.collection('good', { name: 'Good', description: '' }, [first]);
    const job = createTransfer(store, { ...selection, collectionIds: [broken, good], likes: true, songs: true }, provider.identity);
    await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'needs_review'); assert.equal(store.getJob(job.id)!.failed, 1);
    const session = await app.inject({ url: '/api/auth/status' });
    const cookie = String(session.headers['set-cookie']).split(';')[0];
    const headers = { cookie, 'x-csrf-token': session.json().csrf };
    const url = `/api/jobs/${job.id}/skip-failed`;
    assert.equal((await app.inject({ method: 'POST', url, headers: { cookie } })).statusCode, 403);
    const result = await app.inject({ method: 'POST', url, headers });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().status, 'queued'); assert.equal(result.json().failed, 0); assert.equal(result.json().skipped, 3);
    assert.equal(result.json().total, job.total); assert.deepEqual(result.json().summary, job.summary);
    assert.equal((await app.inject({ method: 'POST', url, headers })).statusCode, 409, 'Repeated clicks cannot skip more actions');
    await worker.tick();
    assert.equal(store.getJob(job.id)!.status, 'completed_with_issues'); assert.equal(store.getJob(job.id)!.failed, 0);
    assert.deepEqual([...provider.playlists.values()].map(playlist => playlist.ids), [['First']]);
    assert.deepEqual([...provider.likes].sort(), ['First', 'Second']); assert.deepEqual([...provider.songs].sort(), ['First', 'Second']);
    const report = (await app.inject({ url: `/api/jobs/${job.id}/report?format=json`, headers })).json();
    assert.equal(report.items.filter((item: any) => item.status === 'skipped').length, 3);
    assert.match(report.items[0].reason, /Playlist creation rejected/);
    assert.equal(store.get("SELECT COUNT(*) n FROM jobs WHERE kind='transfer'")!.n, 1);
  } finally { await app.close(); await temp.cleanup(); }
});

test('skip failed playlist entry preserves completed entries, prior skips, and an uncertain write checkpoint', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory);
  try {
    const first = song(store, 'First'); const second = song(store, 'Second');
    const playlist = store.collection('partial', { name: 'Partially transferred', description: '' }, [first, second, first, second]);
    const other = store.collection('other', { name: 'Other playlist', description: '' }, [first]);
    const job = createTransfer(store, { ...selection, collectionIds: [playlist, other], likes: true }, '@owner');
    store.stepResult(job.id, 0, 'done', 'Created.', 'https://music.youtube.com/playlist?list=existing');
    store.stepResult(job.id, 1, 'done', 'Already transferred.', 'https://music.youtube.com/watch?v=First');
    store.stepResult(job.id, 2, 'failed', 'Recording rejected.');
    store.stepResult(job.id, 3, 'skipped', 'A previous explicit skip.');
    store.setSetting('playlist-append:fixture', JSON.stringify({ jobId: job.id, start: 1, end: 2 }));
    store.run("UPDATE jobs SET payload=json_set(payload,'$.nextCheck',?) WHERE id=?", Date.now() + 60000, job.id);
    store.updateJob(job.id, 'needs_review');
    const completed = store.all("SELECT * FROM steps WHERE job_id=? AND status='done'", job.id);
    const result = skipFailedTransferSteps(store, job.id);
    assert.equal(result.status, 'queued'); assert.equal(result.done, 2); assert.equal(result.failed, 0); assert.equal(result.skipped, 3);
    assert.deepEqual(store.all("SELECT * FROM steps WHERE job_id=? AND status='done'", job.id), completed);
    assert.equal(store.get('SELECT reason FROM steps WHERE job_id=? AND seq=3', job.id)!.reason, 'A previous explicit skip.');
    assert.equal(store.get('SELECT status FROM steps WHERE job_id=? AND seq=4', job.id)!.status, 'skipped');
    assert.ok(store.all("SELECT * FROM steps WHERE job_id=? AND seq>4", job.id).every(step => step.status === 'pending'));
    assert.ok(store.setting('playlist-append:fixture'), 'An uncertain remote write remains recorded');
    assert.equal(JSON.parse(store.get('SELECT payload FROM jobs WHERE id=?', job.id)!.payload).nextCheck, undefined);
    const counts = store.get("SELECT SUM(status='pending') n FROM steps WHERE job_id=?", job.id)!.n;
    assert.equal(result.done + result.skipped + result.failed + counts, result.total);
  } finally { store.close(); await temp.cleanup(); }
});

test('a failed library action skips only that action and finishes when nothing remains', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory);
  try {
    song(store, 'First');
    const job = createTransfer(store, { ...selection, likes: true, songs: true }, '@owner');
    store.stepResult(job.id, 0, 'done', 'Liked.'); store.stepResult(job.id, 1, 'failed', 'Save rejected.');
    store.updateJob(job.id, 'completed_with_issues');
    const result = skipFailedTransferSteps(store, job.id);
    assert.equal(result.status, 'completed_with_issues'); assert.equal(result.done, 1); assert.equal(result.skipped, 1); assert.equal(result.failed, 0);
  } finally { store.close(); await temp.cleanup(); }
});

test('active jobs, cancelled jobs, non-transfer jobs, and jobs without failures cannot be skipped', async () => {
  const temp = await temporaryDirectory(); const store = new Store(temp.directory);
  try {
    const job = store.job('transfer', {}, [{ kind: 'like', sourceId: '{}' }]); store.stepResult(job.id, 0, 'failed', 'Rejected.');
    for (const status of ['queued', 'running', 'cancelled', 'completed'] as const) {
      store.updateJob(job.id, status);
      assert.throws(() => skipFailedTransferSteps(store, job.id), (error: any) => error.statusCode === 409);
      assert.equal(store.getJob(job.id)!.failed, 1);
    }
    const matching = store.job('match', {}, [{ kind: 'match', sourceId: 'entity' }]); store.stepResult(matching.id, 0, 'failed'); store.updateJob(matching.id, 'failed');
    assert.throws(() => skipFailedTransferSteps(store, matching.id), (error: any) => error.statusCode === 409);
    store.updateJob(job.id, 'paused'); store.stepResult(job.id, 0, 'done');
    assert.throws(() => skipFailedTransferSteps(store, job.id), (error: any) => error.statusCode === 409);
    assert.throws(() => skipFailedTransferSteps(store, 'unknown'), (error: any) => error.statusCode === 404);
  } finally { store.close(); await temp.cleanup(); }
});
