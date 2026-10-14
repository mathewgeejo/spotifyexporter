import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, open as openFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { JSONParser } from '@streamparser/json';
import yauzl from 'yauzl';
import { Store, hash, now } from './store.js';
import type { SourceEntity } from '../shared/types.js';

export interface ImportStats { playlists: number; songs: number; albums: number; artists: number; history: number; skipped: number; warnings: string[] }
const blank = (): ImportStats => ({ playlists: 0, songs: 0, albums: 0, artists: 0, history: 0, skipped: 0, warnings: [] });
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const artistNames = (value: any): string[] => Array.isArray(value) ? value.map(v => text(typeof v === 'string' ? v : v?.name)).filter(Boolean) : text(value) ? [text(value)] : [];

export function parseSong(raw: any, flags: Partial<SourceEntity> = {}): Omit<SourceEntity, 'id'> | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw.track && typeof raw.track === 'object' ? raw.track : raw.item && typeof raw.item === 'object' ? raw.item : raw.localTrack && typeof raw.localTrack === 'object' ? raw.localTrack : raw;
  if (value.type === 'episode' || value.episodeName || value.episode_name) return;
  const name = text(value.trackName || value.track || value.name || value.master_metadata_track_name || value.localTrackName || raw.localTrackName);
  const artists = artistNames(value.artists || value.artistName || value.artist || value.master_metadata_album_artist_name);
  const local = !!(raw.localTrack || value.is_local || value.localTrack || value.localTrackName || raw.localTrackName || String(value.uri || value.trackUri || '').startsWith('spotify:local:'));
  if (!name || (!artists.length && !local)) return;
  const album = text(typeof value.album === 'object' ? value.album?.name : value.album || value.albumName || value.master_metadata_album_album_name);
  return { kind: 'song', name, artists, album: album || undefined, uri: text(value.uri || value.trackUri || value.spotify_track_uri) || undefined,
    durationMs: Number.isFinite(value.duration_ms) ? value.duration_ms : undefined,
    explicit: typeof value.explicit === 'boolean' ? value.explicit : undefined,
    local, ...flags };
}

export async function importJson(path: string, filename: string, fileHash: string, store: Store): Promise<ImportStats> {
  const stats = blank(); let playlistIndex = 0; let seen = 0;
  store.db.exec('CREATE TEMP TABLE IF NOT EXISTS event_occurrences (signature TEXT PRIMARY KEY, occurrence INTEGER NOT NULL); DELETE FROM event_occurrences;');
  const handle = await openFile(path, 'r'); const prefix = Buffer.alloc(2048);
  await handle.read(prefix, 0, prefix.length, 0); await handle.close();
  const topArray = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart().startsWith('[');
  const parser = new JSONParser({ paths: topArray ? ['$.*'] : ['$.playlists.*', '$.songs.*', '$.tracks.*', '$.albums.*', '$.artists.*', '$.followingArtists.*'], keepStack: false });
  const historyBatch: { raw: any; index: number }[] = [];
  function flushHistory() {
    store.transaction(() => {
      for (const { raw } of historyBatch) {
        const song = parseSong(raw);
        const date = raw.ts || raw.endTime;
        const normalized = typeof date === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(date) ? `${date.replace(' ', 'T')}:00Z` : date;
        const timestamp = new Date(normalized).getTime(); const ms = raw.ms_played ?? raw.msPlayed;
        if (!song || !Number.isFinite(timestamp) || !Number.isFinite(ms) || ms < 0) { stats.skipped++; continue; }
        const entityId = store.entity(song); const playedAt = new Date(timestamp).toISOString();
        const signature = hash(JSON.stringify([song.uri || [song.name, song.artists, song.album], playedAt, ms, !!raw.skipped]));
        const occurrence = store.get('INSERT INTO event_occurrences VALUES (?,0) ON CONFLICT(signature) DO UPDATE SET occurrence=occurrence+1 RETURNING occurrence', signature)!.occurrence;
        store.run('INSERT OR IGNORE INTO history VALUES (?,?,?,?,?,?)', hash(`${signature}:${occurrence}`), entityId, playedAt, Math.floor(ms), raw.skipped === true ? 1 : 0, filename);
        stats.history++;
      }
    });
    historyBatch.length = 0;
  }
  parser.onValue = event => {
      const raw: any = event.value; const category = topArray ? '' : String(event.stack[1]?.key || ''); seen++;
      if (raw && typeof raw === 'object' && ('ms_played' in raw || 'msPlayed' in raw)) {
        historyBatch.push({ raw, index: seen }); if (historyBatch.length >= 500) flushHistory(); return;
      }
      if (category === 'playlists' || (raw && Array.isArray(raw.items) && typeof raw.name === 'string')) {
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items || raw.tracks?.items)) { stats.skipped++; return; }
        const items: string[] = [];
        for (const item of raw.items || raw.tracks?.items || []) {
          const song = parseSong(item);
          if (song) items.push(store.entity(song)); else stats.skipped++;
        }
        store.collection(`archive:${fileHash}:${playlistIndex++}`, { name: text(raw.name) || 'Untitled playlist', description: text(raw.description), sourceUri: text(raw.uri) || undefined }, items);
        stats.playlists++; return;
      }
      if (category === 'albums') {
        const value = raw?.album && typeof raw.album === 'object' ? raw.album : raw;
        const name = text(value?.name || value?.album); const artists = artistNames(value?.artists || value?.artist);
        if (!name || !artists.length) { stats.skipped++; return; }
        store.entity({ kind: 'album', name, artists, uri: text(value.uri) || undefined, saved: true }); stats.albums++; return;
      }
      if (category === 'artists' || category === 'followingArtists') {
        const name = text(typeof raw === 'string' ? raw : raw?.name || raw?.artist);
        if (!name) { stats.skipped++; return; }
        store.entity({ kind: 'artist', name, artists: [name], uri: text(raw?.uri) || undefined, followed: true }); stats.artists++; return;
      }
      const song = parseSong(raw, { liked: true, saved: true });
      if (song) { store.entity(song); stats.songs++; } else stats.skipped++;
  };
  let firstChunk = true;
  for await (const chunk of createReadStream(path)) {
    const bytes = firstChunk && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf ? chunk.subarray(3) : chunk;
    firstChunk = false; parser.write(bytes);
  }
  if (!parser.isEnded) parser.end();
  flushHistory();
  if (!seen) stats.warnings.push(`${filename}: no supported music records found.`);
  if (stats.skipped) stats.warnings.push(`${filename}: ${stats.skipped} unsupported or incomplete records skipped (including podcasts).`);
  return stats;
}

export function validateArchiveEntry(entry: Pick<yauzl.Entry, 'fileName' | 'uncompressedSize' | 'compressedSize'>, expandedSoFar: number): void {
  const name = entry.fileName.replaceAll('\\', '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || name.includes('\0') || posix.normalize(name).startsWith('../')) throw new Error('Unsafe archive path.');
  if (entry.uncompressedSize > 512 * 1024 * 1024 || expandedSoFar + entry.uncompressedSize > 2 * 1024 * 1024 * 1024) throw new Error('Archive expands beyond the supported size limit.');
  if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 1000) throw new Error('Unsafe archive compression ratio.');
}

async function extractMusic(zipPath: string, directory: string): Promise<{ path: string; name: string }[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error('Could not read ZIP archive.'));
      const files: { path: string; name: string }[] = []; let expanded = 0; let count = 0;
      const fail = (error: Error) => { zip.close(); reject(error); };
      zip.on('error', fail); zip.on('end', () => resolve(files));
      zip.on('entry', (entry: yauzl.Entry) => {
        try { validateArchiveEntry(entry, expanded); expanded += entry.uncompressedSize; if (++count > 2000) throw new Error('Archive has too many files.'); }
        catch (error) { fail(error as Error); return; }
        const name = basename(entry.fileName);
        if (!/\.json$/i.test(name) || !/(playlist|yourlibrary|streaming.?history|streaming_history_audio|following.?artists)/i.test(name)) { zip.readEntry(); return; }
        if (entry.generalPurposeBitFlag & 1) { fail(new Error('Encrypted archives are not supported.')); return; }
        zip.openReadStream(entry, async (error, input) => {
          if (error || !input) { fail(new Error('Could not read an archive entry.')); return; }
          const path = join(directory, `${files.length}-${name}`); let bytes = 0;
          try {
            await pipeline(input, new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; done(bytes > entry.uncompressedSize ? new Error('Invalid archive entry size.') : null, chunk); } }), createWriteStream(path, { flags: 'wx', mode: 0o600 }));
            files.push({ path, name }); zip.readEntry();
          } catch (error) { fail(error as Error); }
        });
      });
      zip.readEntry();
    });
  });
}
async function fileDigest(path: string): Promise<string> { const sha = createHash('sha256'); for await (const chunk of createReadStream(path)) sha.update(chunk); return sha.digest('hex'); }

export async function importUpload(store: Store, uploadPath: string, name: string) {
  const sha = await fileDigest(uploadPath); const existing = store.get('SELECT * FROM imports WHERE sha=?', sha);
  if (existing) return { id: existing.id, duplicate: true, stats: JSON.parse(existing.stats) as ImportStats };
  if (!/\.(json|zip)$/i.test(name)) throw new Error('Upload a Spotify JSON file or ZIP archive.');
  const id = randomUUID(); const work = join(store.directory, 'tmp', id); const filesDir = join(work, 'files');
  await mkdir(filesDir, { recursive: true }); const stage = new Store(join(work, 'db')); const stats = blank();
  let attached = false; let finalDirectory: string | undefined;
  try {
    let files: { path: string; name: string }[];
    if (/\.zip$/i.test(name)) files = await extractMusic(uploadPath, filesDir);
    else { const path = join(filesDir, basename(name)); await pipeline(createReadStream(uploadPath), createWriteStream(path, { flags: 'wx', mode: 0o600 })); files = [{ path, name }]; }
    if (!files.length) throw new Error('No Spotify playlist, library, or history JSON files were found in this archive.');
    for (const file of files) {
      const partial = await importJson(file.path, file.name, await fileDigest(file.path), stage);
      for (const key of ['playlists', 'songs', 'albums', 'artists', 'history', 'skipped'] as const) stats[key] += partial[key];
      stats.warnings.push(...partial.warnings);
    }
    if (!(stats.playlists + stats.songs + stats.albums + stats.artists + stats.history)) throw new Error('No supported music records found. Choose Spotify Account data or Extended streaming history.');
    stage.close();
    const importsDir = join(store.directory, 'imports'); await mkdir(importsDir, { recursive: true });
    finalDirectory = join(importsDir, id); await rename(filesDir, finalDirectory);
    store.run('ATTACH DATABASE ? AS staging', join(work, 'db', 'encore.sqlite')); attached = true;
    store.transaction(() => {
      store.db.exec(`INSERT INTO entities SELECT * FROM staging.entities WHERE 1 ON CONFLICT(id) DO UPDATE SET
        body=json_set(json_patch(entities.body,excluded.body),
        '$.liked',json(CASE WHEN json_extract(entities.body,'$.liked') OR json_extract(excluded.body,'$.liked') THEN 'true' ELSE 'false' END),
        '$.saved',json(CASE WHEN json_extract(entities.body,'$.saved') OR json_extract(excluded.body,'$.saved') THEN 'true' ELSE 'false' END),
        '$.followed',json(CASE WHEN json_extract(entities.body,'$.followed') OR json_extract(excluded.body,'$.followed') THEN 'true' ELSE 'false' END));
        INSERT OR IGNORE INTO collections SELECT * FROM staging.collections;
        INSERT OR IGNORE INTO entries SELECT * FROM staging.entries;
        INSERT OR IGNORE INTO history SELECT * FROM staging.history;`);
      store.run('INSERT INTO imports VALUES (?,?,?,?,?)', id, sha, basename(name), now(), JSON.stringify(stats));
    });
    store.db.exec('DETACH DATABASE staging'); attached = false;
    return { id, duplicate: false, stats };
  } catch (error) {
    if (finalDirectory) await rm(finalDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    if (attached) store.db.exec('DETACH DATABASE staging');
    try { stage.close(); } catch { /* already closed */ }
    await rm(work, { recursive: true, force: true });
  }
}
