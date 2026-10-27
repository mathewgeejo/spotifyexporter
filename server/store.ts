import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Collection, EntityView, Job, JobStatus, SourceEntity, TransferSummary } from '../shared/types.js';

export const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export type Row = Record<string, any>;

export class Store {
  readonly db: DatabaseSync;
  private readonly summaryCache = new Map<string, TransferSummary>();
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'encore.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, sha TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created TEXT NOT NULL, stats TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', target TEXT, candidates TEXT NOT NULL DEFAULT '[]', reason TEXT);
      CREATE INDEX IF NOT EXISTS entity_kind ON entities(kind);
      CREATE INDEX IF NOT EXISTS entity_status ON entities(status);
      CREATE TABLE IF NOT EXISTS collections (id TEXT PRIMARY KEY, source_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE, position INTEGER NOT NULL, entity_id TEXT REFERENCES entities(id), PRIMARY KEY(collection_id,position));
      CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, entity_id TEXT REFERENCES entities(id), played_at TEXT NOT NULL, ms_played INTEGER NOT NULL, skipped INTEGER NOT NULL, source TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_time ON history(played_at);
      CREATE INDEX IF NOT EXISTS history_entity ON history(entity_id);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL, total INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, updated TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS steps (job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT, url TEXT, PRIMARY KEY(job_id,seq));
      CREATE TABLE IF NOT EXISTS destinations (account TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, target TEXT NOT NULL, expected TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(account,kind,source_id));
      PRAGMA user_version=1;`);
  }
  run(sql: string, ...params: any[]) { return this.db.prepare(sql).run(...params); }
  get(sql: string, ...params: any[]): Row | undefined { return this.db.prepare(sql).get(...params) as Row | undefined; }
  all(sql: string, ...params: any[]): Row[] { return this.db.prepare(sql).all(...params) as Row[]; }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key: string): string | undefined { return this.get('SELECT value FROM settings WHERE key=?', key)?.value; }
  setSetting(key: string, value: string) { this.run('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  entity(source: Omit<SourceEntity, 'id'> & { id?: string }): string {
    const id = source.id || hash(source.uri || JSON.stringify([source.kind, source.name, source.artists, source.album || '', source.local || false]));
    const existing = this.get('SELECT body FROM entities WHERE id=?', id);
    const old: Partial<SourceEntity> = existing ? JSON.parse(existing.body) : {};
    const body = { ...old, ...Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined)), id,
      liked: !!(old.liked || source.liked), saved: !!(old.saved || source.saved), followed: !!(old.followed || source.followed) };
    this.run('INSERT INTO entities(id,kind,name,body) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,name=excluded.name', id, source.kind, body.name, JSON.stringify(body));
    return id;
  }
  entityView(row: Row): EntityView {
    return { ...JSON.parse(row.body), matchStatus: row.status, target: row.target ? JSON.parse(row.target) : undefined, candidates: JSON.parse(row.candidates), reason: row.reason || undefined };
  }
  getEntity(id: string): EntityView | undefined { const row = this.get('SELECT * FROM entities WHERE id=?', id); return row ? this.entityView(row) : undefined; }
  collection(sourceKey: string, body: Omit<Collection, 'id' | 'count'>, entityIds: string[]): string {
    const existing = this.get('SELECT id FROM collections WHERE source_key=?', sourceKey);
    const id = existing?.id || hash(sourceKey);
    this.transaction(() => {
      this.run('INSERT INTO collections VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', id, sourceKey, JSON.stringify({ ...body, id, count: entityIds.length }));
      this.run('DELETE FROM entries WHERE collection_id=?', id);
      const stmt = this.db.prepare('INSERT INTO entries VALUES (?,?,?)');
      entityIds.forEach((entityId, position) => stmt.run(id, position, entityId));
    });
    return id;
  }
  collections(): Collection[] { return this.all('SELECT body FROM collections ORDER BY rowid').map(row => JSON.parse(row.body)); }
  job(kind: Job['kind'], payload: unknown, steps: { kind: string; sourceId: string }[] = []): Job {
    const id = randomUUID(); const timestamp = now();
    this.transaction(() => {
      this.run('INSERT INTO jobs(id,kind,status,payload,total,created,updated) VALUES (?,?,?,?,?,?,?)', id, kind, 'queued', JSON.stringify(payload), steps.length, timestamp, timestamp);
      steps.forEach((step, seq) => this.run('INSERT INTO steps(job_id,seq,kind,source_id) VALUES (?,?,?,?)', id, seq, step.kind, step.sourceId));
    });
    return this.getJob(id)!;
  }
  jobView(row: Row): Job {
    let summary: TransferSummary | undefined;
    if (row.kind === 'transfer') {
      summary = this.summaryCache.get(row.id);
      if (!summary) {
        summary = JSON.parse(row.payload).summary;
        if (!summary) {
          // Backfill older job views without modifying their saved transfer plans.
          const counts = Object.fromEntries(this.all('SELECT kind,COUNT(*) n FROM steps WHERE job_id=? GROUP BY kind', row.id).map(item => [item.kind, item.n]));
          const sourceItems = this.get("SELECT COUNT(DISTINCT COALESCE(json_extract(source_id,'$.entity.id'),json_extract(source_id,'$.id'))) n FROM steps WHERE job_id=? AND kind!='playlist'", row.id)!.n;
          summary = { sourceItems, playlists: counts.playlist || 0, playlistEntries: counts.playlist_item || 0,
            likes: counts.like || 0, savedSongs: counts.song || 0, albums: counts.album || 0, artists: counts.artist || 0 };
        }
        this.summaryCache.set(row.id, summary!);
      }
    }
    return { id: row.id, kind: row.kind, status: row.status, total: row.total, done: row.done, failed: row.failed, skipped: row.skipped,
      message: row.message, createdAt: row.created, updatedAt: row.updated, ...(summary ? { summary } : {}) };
  }
  getJob(id: string): Job | undefined { const row = this.get('SELECT * FROM jobs WHERE id=?', id); return row ? this.jobView(row) : undefined; }
  updateJob(id: string, status: JobStatus, message?: string) {
    this.run('UPDATE jobs SET status=?,message=COALESCE(?,message),updated=? WHERE id=?', status, message ?? null, now(), id);
  }
  stepResult(jobId: string, seq: number, status: string, reason?: string, url?: string) {
    this.transaction(() => {
      this.run('UPDATE steps SET status=?,reason=?,url=? WHERE job_id=? AND seq=?', status, reason || null, url || null, jobId, seq);
      const counts = this.get("SELECT SUM(status='done') AS done,SUM(status='failed') AS failed,SUM(status='skipped') AS skipped FROM steps WHERE job_id=?", jobId)!;
      this.run('UPDATE jobs SET done=?,failed=?,skipped=?,updated=? WHERE id=?', counts.done || 0, counts.failed || 0, counts.skipped || 0, now(), jobId);
    });
  }
  close() { this.db.close(); }
}
