import { Store, now } from './store.js';

const conflict = (message: string) => Object.assign(new Error(message), { statusCode: 409 });

export function skipFailedTransferSteps(store: Store, id: string) {
  return store.transaction(() => {
    const job = store.getJob(id);
    if (!job) throw Object.assign(new Error('Job not found.'), { statusCode: 404 });
    if (job.kind !== 'transfer') throw conflict('Only music transfers support skipping failed actions.');
    if (['queued', 'running', 'cancelled', 'completed'].includes(job.status)) throw conflict('Pause the transfer before skipping failed actions.');
    const unfinished = store.all("SELECT seq,kind,source_id,status,reason FROM steps WHERE job_id=? AND status IN ('pending','failed') ORDER BY seq", id);
    const failed = unfinished.filter(step => step.status === 'failed');
    if (!failed.length) throw conflict('This transfer has no failed actions to skip.');
    const playlists = new Set<string>();
    for (const step of failed) {
      const source = JSON.parse(step.source_id);
      if (step.kind === 'playlist') playlists.add(source.id);
      if (step.kind === 'playlist_item') playlists.add(source.collectionId);
    }
    let skipped = 0;
    for (const step of unfinished) {
      const related = step.kind === 'playlist_item' && playlists.has(JSON.parse(step.source_id).collectionId);
      if (step.status !== 'failed' && !related) continue;
      const reason = step.status === 'failed'
        ? `Skipped by owner after failure. ${step.reason || ''}`.trim()
        : 'Skipped by owner because this playlist has a failed action. Other playlists and library actions can continue.';
      store.run("UPDATE steps SET status='skipped',reason=? WHERE job_id=? AND seq=?", reason, id, step.seq);
      skipped++;
    }
    // Keep completed actions, source selections, destination mappings, and write
    // intents intact. Skipping never edits or removes music already on YouTube.
    const counts = store.get("SELECT SUM(status='done') done,SUM(status='failed') failed,SUM(status='skipped') skipped,SUM(status='pending') pending FROM steps WHERE job_id=?", id)!;
    store.run("UPDATE jobs SET done=?,failed=?,skipped=?,status=?,message=?,payload=json_remove(payload,'$.nextCheck'),updated=? WHERE id=?",
      counts.done || 0, counts.failed || 0, counts.skipped || 0, counts.pending ? 'queued' : 'completed_with_issues',
      `${skipped} failed or related actions skipped. ${counts.pending ? 'Continuing with the remaining music.' : 'Transfer finished with skipped actions.'}`, now(), id);
    return store.getJob(id)!;
  });
}
