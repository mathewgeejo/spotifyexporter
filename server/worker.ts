import type { Collection, EntityView, TransferSelection } from '../shared/types.js';
import { Store, hash } from './store.js';
import { chooseMatch } from './matching.js';
import { ProviderError, ReviewRequired, type MusicProvider } from './youtube.js';
import type { SpotifyAdapter } from './spotify.js';

class Stopped extends Error {}
export function selectedEntities(store: Store, selection: TransferSelection): string[] {
  const ids = new Set<string>(selection.favoriteIds);
  for (const id of selection.collectionIds) for (const row of store.all('SELECT entity_id FROM entries WHERE collection_id=? ORDER BY position', id)) ids.add(row.entity_id);
  const library = store.all(`SELECT id FROM entities WHERE
    (kind='song' AND ((?=1 AND json_extract(body,'$.liked')=1) OR (?=1 AND json_extract(body,'$.saved')=1)))
    OR (kind='album' AND ?=1 AND json_extract(body,'$.saved')=1)
    OR (kind='artist' AND ?=1 AND json_extract(body,'$.followed')=1)`, Number(selection.likes), Number(selection.songs), Number(selection.albums), Number(selection.artists));
  for (const row of library) ids.add(row.id);
  return [...ids];
}
interface TransferSnapshot { entityIds: string[]; collections: { collection: Collection; entries: string[] }[] }
function snapshotSelection(store: Store, selection: TransferSelection): TransferSnapshot {
  const entityIds = selectedEntities(store, selection);
  if (entityIds.some(id => !store.getEntity(id))) throw new Error('A selected source record no longer exists.');
  const collections = selection.collectionIds.map(id => {
    const collection = store.collections().find(item => item.id === id);
    if (!collection) throw new Error('A selected playlist no longer exists.');
    if (collection.inaccessible) throw new Error(`Upload archive contents for "${collection.name}" or deselect it.`);
    return { collection, entries: store.all('SELECT entity_id FROM entries WHERE collection_id=? ORDER BY position', id).map(row => row.entity_id as string) };
  });
  if (!entityIds.length && !collections.length) throw new Error('Select at least one playlist or library item.');
  return { entityIds, collections };
}

export function queueTransfer(store: Store, selection: TransferSelection, account: string) {
  const snapshot = snapshotSelection(store, selection);
  const pending: string[] = [];
  // Existing review candidates can be resolved immediately without another catalog request.
  store.transaction(() => {
    for (const id of snapshot.entityIds) {
      const entity = store.getEntity(id)!;
      if (['matched', 'skipped'].includes(entity.matchStatus)) continue;
      if (!entity.local && !entity.candidates.length && entity.matchStatus !== 'missing') { pending.push(id); continue; }
      const result = chooseMatch(entity, entity.candidates);
      store.run('UPDATE entities SET status=?,target=?,candidates=?,reason=? WHERE id=?', result.status, result.target ? JSON.stringify(result.target) : null, JSON.stringify(result.candidates), result.reason, id);
    }
  });
  if (!pending.length) return createTransfer(store, selection, account, { snapshot });
  const job = store.job('match', { account, transferSelection: selection, transferSnapshot: snapshot }, pending.map(sourceId => ({ kind: 'match', sourceId })));
  store.updateJob(job.id, 'queued', 'Finding the best matches. Your transfer will start automatically.');
  return store.getJob(job.id)!;
}

export function createTransfer(store: Store, selection: TransferSelection, account: string, options: { snapshot?: TransferSnapshot; sourceMatchJobId?: string } = {}) {
  const snapshot = options.snapshot || snapshotSelection(store, selection);
  const entities = snapshot.entityIds.map(id => store.getEntity(id));
  if (entities.some(e => !e)) throw new Error('A selected source record no longer exists.');
  const unresolved = entities.filter(e => e && !['matched', 'skipped'].includes(e.matchStatus));
  if (unresolved.length) throw new Error(`Matching has not finished for ${unresolved.length} items. Retry the failed searches before continuing.`);
  const steps: { kind: string; sourceId: string }[] = []; const sequences: Record<string, string[]> = {};
  for (const { collection, entries } of snapshot.collections) {
    const collectionId = collection.id;
    steps.push({ kind: 'playlist', sourceId: JSON.stringify(collection) });
    sequences[collectionId] = []; let destinationIndex = 0;
    for (const [position, entityId] of entries.entries()) {
      const entity = store.getEntity(entityId)!;
      if (entity.matchStatus === 'matched') sequences[collectionId].push(entity.target!.id);
      steps.push({ kind: 'playlist_item', sourceId: JSON.stringify({ collectionId, position, destinationIndex: entity.matchStatus === 'matched' ? destinationIndex++ : -1, entity }) });
    }
  }
  const favorites = new Set(selection.favoriteIds);
  for (const entity of entities as EntityView[]) {
    if (entity.kind === 'song') {
      if ((selection.likes && entity.liked) || favorites.has(entity.id)) steps.push({ kind: 'like', sourceId: JSON.stringify(entity) });
      if (selection.songs && entity.saved) steps.push({ kind: 'song', sourceId: JSON.stringify(entity) });
    }
  }
  for (const kind of ['album', 'artist'] as const) for (const entity of entities as EntityView[]) {
    if (entity.kind === kind && (kind === 'album' ? selection.albums && entity.saved : selection.artists && entity.followed)) steps.push({ kind, sourceId: JSON.stringify(entity) });
  }
  if (!steps.length) throw new Error('Select at least one playlist or library item.');
  return store.job('transfer', { selection, account, sequences, ...(options.sourceMatchJobId ? { sourceMatchJobId: options.sourceMatchJobId } : {}) }, steps);
}
const equal = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => b[index] === value);
export function reconcilePlaylist(actual: string[], desired: string[], confirmed: string[]): number {
  if (actual.length < confirmed.length || !equal(actual.slice(0, confirmed.length), confirmed) || !equal(actual, desired.slice(0, actual.length))) throw new ReviewRequired('Destination playlist changed outside this transfer. Restore its previous order and contents in YouTube Music before resuming.');
  return actual.length;
}

export class Worker {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private closed = false;
  constructor(private readonly store: Store, private readonly getProvider: () => Promise<MusicProvider>, private readonly spotify?: SpotifyAdapter) {}
  get isBusy() { return this.busy; }
  start() {
    this.store.run("UPDATE jobs SET status='paused',message='Interrupted by a server restart. Resume to reconcile and continue.' WHERE status='running'");
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }
  async stop() { this.closed = true; if (this.timer) clearInterval(this.timer); while (this.busy) await new Promise(resolve => setTimeout(resolve, 50)); }
  private check(id: string) { if (this.closed || this.store.getJob(id)?.status !== 'running') throw new Stopped(); }
  private async wait(id: string, ms: number) {
    const until = Date.now() + ms;
    while (Date.now() < until) { this.check(id); await new Promise(resolve => setTimeout(resolve, Math.min(250, until - Date.now()))); }
  }
  private async retry<T>(id: string, action: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.check(id);
      try { return await action(); }
      catch (error) {
        if (error instanceof ReviewRequired || error instanceof Stopped || !(error instanceof ProviderError) || error.status < 429 || (error.status < 500 && error.status !== 429) || attempt >= 3) throw error;
        await this.wait(id, Math.min(300000, Math.max(error.retryAfter * 1000, 1000 * 2 ** attempt)));
      }
    }
  }
  async tick() {
    if (this.busy || this.closed) return;
    const row = this.store.get("SELECT * FROM jobs WHERE status='queued' ORDER BY created LIMIT 1"); if (!row) return;
    this.busy = true; this.store.updateJob(row.id, 'running', 'Working…');
    try {
      if (row.kind === 'spotify_import') {
        if (!this.spotify) throw new Error('Spotify integration is unavailable.');
        await this.retry(row.id, () => this.spotify!.importAll(row.id, () => this.check(row.id))); this.check(row.id);
        this.store.updateJob(row.id, this.store.getJob(row.id)!.skipped ? 'completed_with_issues' : 'completed'); return;
      }
      const provider = await this.getProvider(); this.check(row.id); const payload = JSON.parse(row.payload);
      if (payload.account && payload.account !== provider.identity) throw new ReviewRequired('This job belongs to a different YouTube account. Reconnect that account to resume.');
      if (!payload.account) { payload.account = provider.identity; this.store.run('UPDATE jobs SET payload=? WHERE id=?', JSON.stringify(payload), row.id); }
      while (true) {
        this.check(row.id); const step = this.store.get("SELECT * FROM steps WHERE job_id=? AND status='pending' ORDER BY seq LIMIT 1", row.id); if (!step) break;
        let cooldown = 250;
        try {
          if (row.kind === 'match') cooldown = await this.match(row.id, step, provider) ? 250 : 0;
          else if (step.kind === 'playlist_item') await this.playlistItems(row.id, step, provider, payload);
          else await this.transferStep(row.id, step, provider);
        } catch (error) {
          if (error instanceof ReviewRequired || error instanceof Stopped || (error instanceof ProviderError && [401, 403, 429].includes(error.status))) throw error;
          this.store.stepResult(row.id, step.seq, 'failed', error instanceof ProviderError ? error.message : 'This item could not be processed. Retry it from the transfer report.');
        }
        if (cooldown) await this.wait(row.id, cooldown);
      }
      const job = this.store.getJob(row.id)!;
      if (row.kind === 'match' && payload.transferSelection) {
        if (job.failed) {
          this.store.updateJob(row.id, 'completed_with_issues', 'Some catalog searches failed. Retry failed items to start your transfer automatically.');
          return;
        }
        this.check(row.id);
        // A restart between queuing the transfer and completing this job must not queue it twice.
        const existing = this.store.get("SELECT id FROM jobs WHERE kind='transfer' AND json_extract(payload,'$.sourceMatchJobId')=?", row.id);
        const transfer = existing || createTransfer(this.store, payload.transferSelection, provider.identity, { snapshot: payload.transferSnapshot, sourceMatchJobId: row.id });
        payload.transferJobId = transfer.id;
        this.store.run('UPDATE jobs SET payload=? WHERE id=?', JSON.stringify(payload), row.id);
        this.store.updateJob(row.id, job.skipped ? 'completed_with_issues' : 'completed', 'Best matches selected. Your transfer is queued automatically.');
        return;
      }
      this.store.updateJob(row.id, job.failed || job.skipped ? 'completed_with_issues' : 'completed', row.kind === 'match' ? 'Best matches selected. Ready to transfer.' : 'Transfer finished. Open the report for destination links and item outcomes.');
    } catch (error) {
      if (error instanceof Stopped) return;
      this.store.updateJob(row.id, error instanceof ReviewRequired ? 'needs_review' : error instanceof ProviderError ? 'paused' : 'failed', error instanceof ProviderError || error instanceof ReviewRequired ? error.message : 'The job could not finish. Check connection settings and resume.');
    } finally { this.busy = false; }
  }
  private async match(jobId: string, step: any, provider: MusicProvider) {
    const entity = this.store.getEntity(step.source_id);
    if (!entity) { this.store.stepResult(jobId, step.seq, 'skipped', 'Source record no longer exists.'); return false; }
    if (['matched', 'skipped'].includes(entity.matchStatus)) { this.store.stepResult(jobId, step.seq, 'done', 'Previously resolved.'); return false; }
    const searched = !entity.local && !entity.candidates.length && entity.matchStatus !== 'missing';
    const candidates = searched ? await this.retry(jobId, () => provider.search(entity.kind, `${entity.name} ${entity.kind === 'artist' ? '' : entity.artists.join(' ')}`)) : entity.candidates;
    this.check(jobId);
    // A user may have resolved this record while the search request was in flight.
    if (['matched', 'skipped'].includes(this.store.getEntity(entity.id)!.matchStatus)) { this.store.stepResult(jobId, step.seq, 'done', 'Resolved by owner.'); return searched; }
    const result = chooseMatch(entity, candidates);
    this.store.run('UPDATE entities SET status=?,target=?,candidates=?,reason=? WHERE id=?', result.status, result.target ? JSON.stringify(result.target) : null, JSON.stringify(result.candidates), result.reason, entity.id);
    this.store.stepResult(jobId, step.seq, result.status === 'skipped' ? 'skipped' : 'done', result.reason);
    return searched;
  }
  private async transferStep(jobId: string, step: any, provider: MusicProvider) {
    const source = JSON.parse(step.source_id);
    if (step.kind === 'playlist') {
      const marker = `[encore:${hash(`${provider.identity}:${source.id}`).slice(0, 32)}]`;
      await this.retry(jobId, async () => {
        let destination = this.store.get('SELECT * FROM destinations WHERE account=? AND kind=? AND source_id=?', provider.identity, 'playlist', source.id);
        if (destination?.target && destination.target !== '__creating__') return;
        let target: string | undefined;
        if (destination) target = await provider.findPlaylist(marker);
        if (!target) {
          this.store.run('INSERT OR IGNORE INTO destinations VALUES (?,?,?,?,?)', provider.identity, 'playlist', source.id, '__creating__', '[]');
          target = await provider.createPlaylist(source.name, `${String(source.description || '').slice(0, 4900)}\n\n${marker}`);
        }
        this.store.run('UPDATE destinations SET target=? WHERE account=? AND kind=? AND source_id=?', target, provider.identity, 'playlist', source.id);
      });
      const destination = this.store.get('SELECT target FROM destinations WHERE account=? AND kind=? AND source_id=?', provider.identity, 'playlist', source.id)!;
      this.store.stepResult(jobId, step.seq, 'done', 'Private playlist ready.', `https://music.youtube.com/playlist?list=${encodeURIComponent(destination.target)}`); return;
    }
    const entity = source as EntityView;
    if (entity.matchStatus === 'skipped' || !entity.target) { this.store.stepResult(jobId, step.seq, 'skipped', entity.reason || 'Skipped by owner.'); return; }
    const done = this.store.get('SELECT target FROM destinations WHERE account=? AND kind=? AND source_id=?', provider.identity, step.kind, entity.id);
    if (done?.target !== entity.target.id) {
      await this.retry(jobId, async () => {
        if (step.kind === 'like') await provider.like(entity.target!.id);
        else if (step.kind === 'song') await provider.saveSong(entity.target!);
        else if (step.kind === 'album') await provider.saveAlbum(entity.target!.id);
        else if (step.kind === 'artist') await provider.followArtist(entity.target!.id);
      });
      this.store.run('INSERT INTO destinations VALUES (?,?,?,?,?) ON CONFLICT(account,kind,source_id) DO UPDATE SET target=excluded.target', provider.identity, step.kind, entity.id, entity.target.id, '[]');
    }
    this.store.stepResult(jobId, step.seq, 'done', 'Confirmed by YouTube Music.', entity.target.url);
  }
  private async playlistItems(jobId: string, first: any, provider: MusicProvider, payload: any) {
    const initial = JSON.parse(first.source_id);
    if (initial.destinationIndex < 0) { this.store.stepResult(jobId, first.seq, 'skipped', initial.entity.reason || 'Skipped by owner.'); return; }
    const batch = this.store.all("SELECT * FROM steps WHERE job_id=? AND seq>=? AND status='pending' ORDER BY seq LIMIT 50", jobId, first.seq);
    const selected: { row: any; value: any }[] = [];
    for (const row of batch) {
      if (row.kind !== 'playlist_item') break;
      const value = JSON.parse(row.source_id); if (value.collectionId !== initial.collectionId || value.destinationIndex < 0) break;
      selected.push({ row, value });
    }
    const destination = this.store.get('SELECT * FROM destinations WHERE account=? AND kind=? AND source_id=?', provider.identity, 'playlist', initial.collectionId);
    if (!destination || destination.target === '__creating__') throw new ReviewRequired('The destination playlist was not created successfully. Retry its failed creation step.');
    const desired: string[] = payload.sequences[initial.collectionId]; const end = selected.at(-1)!.value.destinationIndex + 1;
    await this.retry(jobId, async () => {
      this.check(jobId); const saved = this.store.get('SELECT expected FROM destinations WHERE account=? AND kind=? AND source_id=?', provider.identity, 'playlist', initial.collectionId)!;
      const actual = await provider.playlistItems(destination.target); const count = reconcilePlaylist(actual, desired, JSON.parse(saved.expected));
      if (count < initial.destinationIndex) throw new ReviewRequired('Earlier playlist entries are incomplete. Retry the failed entries before continuing.');
      if (count < end) {
        this.check(jobId); await provider.append(destination.target, desired.slice(count, end));
        const confirmed = await provider.playlistItems(destination.target);
        if (!equal(confirmed, desired.slice(0, end))) throw new ReviewRequired('YouTube returned unexpected playlist contents after an append. Inspect the destination before resuming.');
      }
      const expected = desired.slice(0, Math.max(count, end));
      this.store.run('UPDATE destinations SET expected=? WHERE account=? AND kind=? AND source_id=?', JSON.stringify(expected), provider.identity, 'playlist', initial.collectionId);
    });
    for (const { row, value } of selected) this.store.stepResult(jobId, row.seq, 'done', 'Ordered playlist entry verified.', value.entity.target.url);
  }
}
