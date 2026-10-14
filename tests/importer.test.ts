import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Store } from '../server/store.js';
import { importUpload, parseSong, validateArchiveEntry } from '../server/importer.js';
import { temporaryDirectory } from './helpers.js';

test('playlists preserve Unicode names, same-name occurrences, and duplicate track order; identical imports deduplicate', async () => {
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data'));
  try {
    const song = { track: { trackName: '夜に駆ける', artistName: 'YOASOBI', albumName: 'THE BOOK', trackUri: 'spotify:track:one' } };
    const upload = join(temp.directory, 'Playlist.json'); await writeFile(upload, JSON.stringify({ playlists: [{ name: 'お気に入り', description: 'A memory', items: [song, song] }, { name: 'お気に入り', items: [song] }] }));
    const result = await importUpload(store, upload, 'Playlist.json'); assert.equal(result.stats.playlists, 2);
    assert.equal(store.collections().length, 2); assert.deepEqual(store.collections().map(c => c.count), [2, 1]);
    const entries = store.all('SELECT entity_id FROM entries WHERE collection_id=? ORDER BY position', store.collections()[0].id);
    assert.equal(entries.length, 2); assert.equal(entries[0].entity_id, entries[1].entity_id);
    assert.equal((await importUpload(store, upload, 'Playlist.json')).duplicate, true); assert.equal(store.collections().length, 2);
  } finally { store.close(); await temp.cleanup(); }
});
test('YourLibrary supports saved songs, albums, and explicitly saved artists; history preserves real timestamps', async () => {
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data'));
  try {
    const library = join(temp.directory, 'YourLibrary.json'); await writeFile(library, JSON.stringify({ tracks: [{ track: 'Song', artist: 'Artist', album: 'Album', uri: 'spotify:track:one' }], albums: [{ album: 'Album', artist: 'Artist', uri: 'spotify:album:one' }], artists: [{ artist: 'Artist', uri: 'spotify:artist:one' }] }));
    const result = await importUpload(store, library, 'YourLibrary.json'); assert.equal(result.stats.songs, 1); assert.equal(result.stats.albums, 1); assert.equal(result.stats.artists, 1);
    const song = store.all("SELECT * FROM entities WHERE kind='song'")[0]; assert.equal(JSON.parse(song.body).liked, true);
    const history = join(temp.directory, 'StreamingHistory.json'); await writeFile(history, JSON.stringify([{ endTime: '2024-01-01 12:30', artistName: 'Artist', trackName: 'Song', msPlayed: 42000 }]));
    await importUpload(store, history, 'StreamingHistory.json'); const event = store.get('SELECT * FROM history')!;
    assert.equal(event.played_at, '2024-01-01T12:30:00.000Z'); assert.equal(event.ms_played, 42000);
    assert.equal(parseSong({ trackName: 'Song', artistName: 'Artist', msPlayed: 123456 })!.durationMs, undefined);
    assert.equal(parseSong({ localTrack: { localTrackName: 'An original local file' } })!.local, true);
  } finally { store.close(); await temp.cleanup(); }
});
test('large history arrays are streamed, repeated events preserved, and malformed imports commit no partial records', async () => {
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data'));
  try {
    const events = Array.from({ length: 12000 }, (_, i) => ({ ts: new Date(1700000000000 + i * 1000).toISOString(), master_metadata_track_name: `Track ${i % 31}`, master_metadata_album_artist_name: 'Artist', spotify_track_uri: `spotify:track:${i % 31}`, ms_played: 40000, skipped: i % 10 === 0 }));
    events.push(events[0]); const upload = join(temp.directory, 'history.json'); await writeFile(upload, JSON.stringify(events));
    assert.equal((await importUpload(store, upload, 'Streaming_History_Audio.json')).stats.history, 12001);
    assert.equal(store.get('SELECT COUNT(*) n FROM history')!.n, 12001);
    const bad = join(temp.directory, 'bad.json'); await writeFile(bad, '[{"trackName":"Partial","artistName":"Artist","msPlayed":40000,"endTime":"2024-01-01 12:00"},');
    await assert.rejects(importUpload(store, bad, 'StreamingHistory_bad.json'));
    assert.equal(store.get("SELECT COUNT(*) n FROM entities WHERE name='Partial'")!.n, 0);
    assert.equal(store.get('SELECT COUNT(*) n FROM imports')!.n, 1);
  } finally { store.close(); await temp.cleanup(); }
});
test('ZIP imports retain music files, omit non-music data, and reject unsafe paths and expansion limits', async () => {
  const temp = await temporaryDirectory(); const store = new Store(join(temp.directory, 'data'));
  try {
    const upload = join(temp.directory, 'account.zip'); await writeFile(upload, zipSync({ 'Spotify/YourLibrary.json': strToU8(JSON.stringify({ tracks: [{ track: 'Song', artist: 'Artist' }] })), 'Spotify/Payments.json': strToU8('{"card":"PRIVATE"}') }));
    const result = await importUpload(store, upload, 'account.zip'); assert.equal(result.stats.songs, 1);
    const sources = await readdir(join(store.directory, 'imports', result.id)); assert.equal(sources.length, 1); assert.match(sources[0], /YourLibrary/);
    assert.doesNotMatch(await readFile(join(store.directory, 'imports', result.id, sources[0]), 'utf8'), /PRIVATE/);
    for (const fileName of ['../evil.json', '/evil.json', 'C:/evil.json', 'folder/../../evil.json', '..\\evil.json']) assert.throws(() => validateArchiveEntry({ fileName, uncompressedSize: 1, compressedSize: 1 }, 0));
    assert.throws(() => validateArchiveEntry({ fileName: 'history.json', uncompressedSize: 600 * 1024 * 1024, compressedSize: 1024 }, 0));
    const evil = join(temp.directory, 'evil.zip'); await writeFile(evil, zipSync({ '../YourLibrary.json': strToU8('{}') }));
    await assert.rejects(importUpload(store, evil, 'evil.zip')); assert.equal(store.get('SELECT COUNT(*) n FROM imports')!.n, 1);
  } finally { store.close(); await temp.cleanup(); }
});
