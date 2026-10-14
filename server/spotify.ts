import { randomBytes, createHash } from 'node:crypto';
import { config } from './config.js';
import { Store, hash, now } from './store.js';
import type { Vault } from './security.js';
import { parseSong } from './importer.js';
import { ProviderError, ReviewRequired } from './youtube.js';

interface SpotifyToken { access_token: string; refresh_token: string; expires_at: number; account: string; userId: string }
export class SpotifyAdapter {
  constructor(private readonly store: Store, private readonly vault: Vault) {}
  startAuthorization() {
    if (!config.spotifyClientId) throw new Error('Set SPOTIFY_CLIENT_ID in the server configuration first.');
    const state = randomBytes(32).toString('hex'); const verifier = randomBytes(48).toString('base64url');
    this.vault.set('spotify-pkce', { state, verifier, expires: Date.now() + 600000 });
    const query = new URLSearchParams({ client_id: config.spotifyClientId, response_type: 'code', redirect_uri: config.spotifyRedirectUri,
      scope: 'playlist-read-private playlist-read-collaborative user-library-read user-follow-read user-read-recently-played user-read-private',
      state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    return { url: `https://accounts.spotify.com/authorize?${query}` };
  }
  async completeAuthorization(code: string, state: string) {
    const pending = this.vault.get<{ state: string; verifier: string; expires: number }>('spotify-pkce');
    this.vault.remove('spotify-pkce');
    if (!pending || pending.state !== state || pending.expires < Date.now()) throw new Error('Spotify authorization expired or did not match this session. Try connecting again.');
    const token = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.spotifyRedirectUri, code_verifier: pending.verifier });
    const response = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Spotify could not identify your account. Check developer-app eligibility and approved users.');
    const profile: any = await response.json();
    this.vault.set('spotify', { ...token, account: profile.display_name || profile.id, userId: profile.id });
  }
  private async tokenRequest(params: Record<string, string>) {
    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: config.spotifyClientId }), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new ProviderError('Spotify authorization failed. Reconnect or use a Spotify data archive.', response.status);
    const data: any = await response.json(); return { ...data, expires_at: Date.now() + data.expires_in * 1000 };
  }
  private async get(path: string): Promise<any> {
    let token = this.vault.get<SpotifyToken>('spotify');
    if (!token) throw new ProviderError('Connect Spotify or upload its export files.', 401);
    if (token.expires_at < Date.now() + 60000) {
      const refreshed = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
      const previous = token;
      token = { ...previous, ...refreshed, refresh_token: refreshed.refresh_token || previous.refresh_token }; this.vault.set('spotify', token);
    }
    const url = new URL(path.startsWith('https:') ? path : `https://api.spotify.com/v1${path}`);
    if (url.hostname !== 'api.spotify.com' || url.protocol !== 'https:' || !url.pathname.startsWith('/v1/')) throw new Error('Invalid Spotify pagination URL.');
    if (!token) throw new ProviderError('Spotify session could not be refreshed. Reconnect your account.', 401);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new ProviderError(response.status === 403 ? 'Spotify denied this endpoint. Use Account data import for collections your developer app cannot read.' : response.status === 429 ? 'Spotify is rate limiting this import. Resume after waiting.' : 'Spotify request failed. Reconnect or resume the import.', response.status, Number(response.headers.get('retry-after') || 0));
    return response.json();
  }
  async *pages(path: string, nested?: string): AsyncGenerator<any[]> {
    let next: string | null = path; const visited = new Set<string>();
    while (next) {
      if (visited.has(next)) throw new Error('Spotify returned a repeated pagination cursor.'); visited.add(next);
      const response = await this.get(next); const page = nested ? response[nested] : response;
      yield page?.items || []; next = page?.next || null;
    }
  }
  async importAll(jobId: string, check: () => void) {
    const token = this.vault.get<SpotifyToken>('spotify'); if (!token) throw new ProviderError('Connect Spotify first.', 401);
    let count = 0; const update = (message: string) => this.store.run('UPDATE jobs SET done=?,message=?,updated=? WHERE id=?', count, message, now(), jobId);
    for await (const playlists of this.pages('/me/playlists?limit=50')) {
      check();
      for (const playlist of playlists) {
        check(); const items: string[] = []; let inaccessible = false;
        try {
          for await (const page of this.pages(`/playlists/${encodeURIComponent(playlist.id)}/items?limit=100`)) {
            check(); for (const item of page) { const song = parseSong(item); if (song) items.push(this.store.entity(song)); }
          }
        } catch (error) {
          if (error instanceof ProviderError && (error.status === 403 || error.status === 404)) inaccessible = true; else throw error;
        }
        // Never overwrite previously imported contents with an inaccessible API response.
        const sourceKey = `spotify:${token.userId}:${playlist.id}`;
        if (!inaccessible || !this.store.get('SELECT id FROM collections WHERE source_key=?', sourceKey)) this.store.collection(sourceKey, {
          name: playlist.name, description: playlist.description || '', sourceUri: playlist.uri, inaccessible,
        }, items);
        count++; update(inaccessible ? `Imported ${playlist.name} metadata. Upload an archive for its tracks.` : `Imported ${playlist.name}`);
      }
    }
    for (const [path, kind] of [['/me/tracks?limit=50', 'song'], ['/me/albums?limit=50', 'album'], ['/me/following?type=artist&limit=50', 'artist']] as const) {
      for await (const page of this.pages(path, kind === 'artist' ? 'artists' : undefined)) {
        check(); this.store.transaction(() => {
          for (const record of page) {
            if (kind === 'song') { const song = parseSong(record, { liked: true, saved: true }); if (song) this.store.entity(song); }
            else {
              const item = record.album || record;
              this.store.entity({ kind, name: item.name, artists: kind === 'artist' ? [item.name] : (item.artists || []).map((a: any) => a.name), uri: item.uri, saved: kind === 'album', followed: kind === 'artist' });
            }
            count++;
          }
        }); update(`Imported ${count} Spotify collection and library records.`);
      }
    }
    for await (const page of this.pages('/me/player/recently-played?limit=50')) {
      check(); this.store.transaction(() => {
        for (const item of page) {
          const song = parseSong(item); if (!song || !item.played_at) continue;
          const id = this.store.entity(song);
          // Recent-play API does not expose listening duration. Zero means unknown.
          this.store.run('INSERT OR IGNORE INTO history VALUES (?,?,?,?,?,?)', hash(JSON.stringify([song.uri, item.played_at, 'recent'])), id, item.played_at, 0, 0, 'Spotify recently played API');
        }
      });
    }
    this.store.run('UPDATE jobs SET total=?,done=?,message=?,updated=? WHERE id=?', count, count, 'Spotify snapshot imported. Lifetime history still requires the extended-history archive.', now(), jobId);
  }
}
