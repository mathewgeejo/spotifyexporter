import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { Candidate, EntityKind } from '../shared/types.js';
import type { MusicProvider } from '../server/youtube.js';
import { ProviderError } from '../server/youtube.js';

export async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'encore-test-'));
  return { directory, cleanup: async () => { const inside = relative(resolve(tmpdir()), resolve(directory)); if (inside.startsWith('..') || isAbsolute(inside) || !inside.startsWith('encore-test-')) throw new Error('Unsafe test cleanup path.'); await rm(directory, { recursive: true, force: true }); } };
}
export class FakeMusic implements MusicProvider {
  identity = '@test-owner'; account = 'Test owner';
  playlists = new Map<string, { name: string; description: string; ids: string[] }>();
  likes = new Set<string>(); songs = new Set<string>(); albums = new Set<string>(); artists = new Set<string>();
  calls = { creates: 0, appends: 0, likes: 0, songs: 0, albums: 0, artists: 0 };
  failAfterAppend = false; failAfterCreate = false; searchError?: ProviderError;
  async search(kind: EntityKind, query: string): Promise<Candidate[]> {
    if (this.searchError) throw this.searchError;
    return [{ id: `yt-${kind}`, name: 'Song', artists: ['Artist'], url: 'https://music.youtube.com/watch?v=test', album: 'Album' }];
  }
  async findPlaylist(marker: string) { return [...this.playlists].find(([, p]) => p.description.includes(marker))?.[0]; }
  async createPlaylist(name: string, description: string) {
    this.calls.creates++; const id = `playlist-${this.calls.creates}`; this.playlists.set(id, { name, description, ids: [] });
    if (this.failAfterCreate) { this.failAfterCreate = false; throw new ProviderError('Simulated lost creation response.', 502); } return id;
  }
  async playlistItems(id: string) { return [...this.playlists.get(id)!.ids]; }
  async append(id: string, ids: string[]) {
    this.calls.appends++; this.playlists.get(id)!.ids.push(...ids);
    if (this.failAfterAppend) { this.failAfterAppend = false; throw new ProviderError('Simulated lost append response.', 502); }
  }
  async like(id: string) { this.calls.likes++; this.likes.add(id); }
  async saveSong(candidate: Candidate) { this.calls.songs++; this.songs.add(candidate.id); }
  async saveAlbum(id: string) { this.calls.albums++; this.albums.add(id); }
  async followArtist(id: string) { this.calls.artists++; this.artists.add(id); }
}
