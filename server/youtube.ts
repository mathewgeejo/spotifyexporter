import { Innertube } from 'youtubei.js';
import type { Candidate, EntityKind } from '../shared/types.js';
import type { Vault } from './security.js';

export class ProviderError extends Error {
  constructor(message: string, readonly status = 502, readonly retryAfter = 0) { super(message); }
}
export class ReviewRequired extends Error {}
export interface YouTubeCredentials { cookie: string; accountIndex: number; channelId?: string; account: string; identity: string }
export interface MusicProvider {
  identity: string;
  account: string;
  search(kind: EntityKind, query: string): Promise<Candidate[]>;
  findPlaylist(marker: string): Promise<string | undefined>;
  createPlaylist(name: string, description: string): Promise<string>;
  playlistItems(id: string): Promise<string[]>;
  append(id: string, videoIds: string[]): Promise<void>;
  like(id: string): Promise<void>;
  saveSong(candidate: Candidate): Promise<void>;
  saveAlbum(id: string): Promise<void>;
  followArtist(id: string): Promise<void>;
}
function nodes(value: any): any[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value.item_type && value.id) return [value];
  if (value.contents) return nodes(value.contents);
  if (value.items) return nodes(value.items);
  return [];
}
function find(value: any, predicate: (value: any) => boolean, seen = new WeakSet<object>()): any {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value); if (predicate(value)) return value;
  for (const child of Object.values(value)) { const result = find(child, predicate, seen); if (result) return result; }
}
function safeError(error: any): ProviderError {
  if (error instanceof ProviderError) return error;
  const info = String(error?.info || '');
  const status = Number(error?.status || error?.status_code || info.match(/"code"\s*:\s*(\d+)/)?.[1] || String(error?.message).match(/status\s*(\d+)/)?.[1] || 502);
  if (status === 401 || status === 403) return new ProviderError('YouTube rejected this session. Reconnect your account in Settings.', status);
  if (status === 429) return new ProviderError('YouTube is rate limiting requests. The job will wait before retrying.', 429, 30);
  return new ProviderError('YouTube Music could not complete the request. Retry or reconnect if the problem continues.', status);
}

export class YouTubeAdapter implements MusicProvider {
  constructor(private readonly client: Innertube, readonly identity: string, readonly account: string) {}
  static async connect(cookie: string, accountIndex = 0, channelId?: string): Promise<{ adapter: YouTubeAdapter; credentials: YouTubeCredentials }> {
    try {
      const client = await Innertube.create({ cookie, account_index: accountIndex, on_behalf_of_user: channelId, lang: 'en', retrieve_player: false, enable_session_cache: false,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(30000) }) });
      const info: any = channelId ? await client.account.getInfo(true) : await client.account.getInfo();
      const accounts: any[] = Array.isArray(info) ? info : info.contents?.contents || [];
      const selected = accounts.find(a => a.is_selected && a.has_channel) || (accounts.length === 1 && accounts[0].has_channel ? accounts[0] : undefined);
      if (!selected) throw new ProviderError('Could not identify the active YouTube channel. Copy a fresh Cookie header from the account you want to use.', 401);
      const handle = selected.channel_handle?.toString() || selected.account_byline?.toString();
      if (!handle && !channelId) throw new ProviderError('This account needs a YouTube channel and handle before it can receive playlists.', 400);
      const account = `${selected.account_name?.toString() || 'YouTube account'}${handle ? ` (${handle})` : ''}`;
      const identity = channelId || handle;
      await client.music.getLibrary(); // Validate that the selected session can access Music.
      return { adapter: new YouTubeAdapter(client, identity, account), credentials: { cookie, accountIndex, channelId, account, identity } };
    } catch (error) { throw safeError(error); }
  }
  private async request(path: string, body: any) {
    try {
      const response = await this.client.actions.execute(path, { ...body, client: 'YTMUSIC' });
      if (!response.success || response.data?.error) throw new ProviderError('YouTube rejected the requested operation.', response.status_code || 502);
      return response.data as any;
    } catch (error) { throw safeError(error); }
  }
  async search(kind: EntityKind, query: string): Promise<Candidate[]> {
    try {
      const results = await this.client.music.search(query, { type: kind === 'song' ? 'song' : kind });
      const list = nodes(results.contents); const unique = new Map<string, Candidate>();
      for (const item of list) {
        if (item.item_type !== kind) continue;
        const name = typeof item.title === 'string' ? item.title : item.title?.toString() || item.name;
        if (!name || !item.id) continue;
        unique.set(item.id, { id: item.id, name, artists: kind === 'artist' ? [name] : (item.artists || item.authors || []).map((a: any) => a.name),
          album: item.album?.name, durationMs: item.duration?.seconds ? item.duration.seconds * 1000 : undefined,
          explicit: item.badges?.some((b: any) => b.icon_type === 'MUSIC_EXPLICIT_BADGE'), available: true,
          url: kind === 'song' ? `https://music.youtube.com/watch?v=${encodeURIComponent(item.id)}` : `https://music.youtube.com/browse/${encodeURIComponent(item.id)}` });
      }
      return [...unique.values()].slice(0, 20);
    } catch (error) { throw safeError(error); }
  }
  async findPlaylist(marker: string) {
    try {
      let library: any = await this.client.music.getLibrary();
      if (library.filters.includes('Playlists')) library = await library.applyFilter('Playlists');
      const matches: string[] = [];
      while (true) {
        for (const item of nodes(library.contents)) {
          if (item.item_type !== 'playlist') continue;
          const playlist: any = await this.client.music.getPlaylist(item.id);
          if (find(playlist.header, value => typeof value.text === 'string' && value.text.includes(marker)) || find(playlist.header, value => typeof value.description === 'string' && value.description.includes(marker))) matches.push(item.id);
        }
        if (!library.has_continuation) break;
        library = await library.getContinuation();
      }
      if (matches.length > 1) throw new ReviewRequired('Multiple destination playlists have the same migration marker. Resolve them in YouTube Music before resuming.');
      return matches[0];
    } catch (error) { if (error instanceof ReviewRequired) throw error; throw safeError(error); }
  }
  async createPlaylist(name: string, description: string) {
    const result = await this.request('/playlist/create', { title: name, description, privacyStatus: 'PRIVATE', videoIds: [] });
    if (!result.playlistId) throw new ProviderError('YouTube did not return the new playlist ID. Resume to reconcile the creation.');
    return String(result.playlistId);
  }
  async playlistItems(id: string): Promise<string[]> {
    try {
      const ids: string[] = []; let page: any = await this.client.music.getPlaylist(id);
      while (true) {
        for (const item of page.items || []) {
          if (item.type === 'ContinuationItem') continue;
          ids.push(item.id || '__unavailable__');
        }
        if (!page.has_continuation) break;
        page = await page.getContinuation();
      }
      return ids;
    } catch (error) { throw safeError(error); }
  }
  async append(id: string, videoIds: string[]) {
    await this.request('/browse/edit_playlist', { playlistId: id, actions: videoIds.map(addedVideoId => ({ action: 'ACTION_ADD_VIDEO', addedVideoId })) });
  }
  async like(id: string) { await this.request('/like/like', { target: { videoId: id } }); }
  async saveSong(candidate: Candidate) {
    try {
      const results = await this.client.music.search(`${candidate.name} ${candidate.artists.join(' ')}`, { type: 'song' });
      const item = nodes(results.contents).find(item => item.id === candidate.id);
      if (!item) throw new ProviderError('The matched song is no longer available in Music search.', 404);
      const menu = item.menu?.items || [];
      const already = menu.find((node: any) => /remove from (your )?library/i.test(node.text?.toString() || ''));
      if (already) return;
      const add = menu.find((node: any) => /add to (your )?library|save to (your )?library/i.test(node.text?.toString() || ''));
      const endpoint = add?.default_endpoint || add?.endpoint;
      if (!endpoint) throw new ProviderError('YouTube did not provide an Add to library action for this recording.', 422);
      const response = await endpoint.call(this.client.actions, { client: 'YTMUSIC' });
      if (!response.success) throw new ProviderError('YouTube could not save this song.');
    } catch (error) { throw safeError(error); }
  }
  async saveAlbum(id: string) {
    try {
      const album: any = await this.client.music.getAlbum(id);
      const add = find(album.header, node => /add to (your )?library|save to (your )?library/i.test(node.text?.toString?.() || ''));
      if (find(album.header, node => /remove from (your )?library/i.test(node.text?.toString?.() || ''))) return;
      const endpoint = add?.default_endpoint || add?.endpoint || add?.default_service_endpoint;
      if (!endpoint) throw new ProviderError('YouTube did not provide an Add to library action for this album.', 422);
      const response = await endpoint.call(this.client.actions, { client: 'YTMUSIC' });
      if (!response.success) throw new ProviderError('YouTube could not save this album.');
    } catch (error) { throw safeError(error); }
  }
  async followArtist(id: string) {
    try {
      const artist: any = await this.client.music.getArtist(id);
      const button = find(artist.header, node => node.type === 'SubscribeButton' && node.channel_id);
      if (!button) throw new ProviderError('YouTube did not provide an artist subscription action.', 422);
      if (button.subscribed) return;
      await this.request('/subscription/subscribe', { channelIds: [button.channel_id] });
    } catch (error) { throw safeError(error); }
  }
}

export class YouTubeFactory {
  private cached?: { secret: string; provider: MusicProvider };
  constructor(private readonly vault: Vault) {}
  clear() { this.cached = undefined; }
  async get(): Promise<MusicProvider> {
    const credentials = this.vault.get<YouTubeCredentials>('youtube');
    if (!credentials) throw new ProviderError('Connect YouTube Music before continuing.', 401);
    const secret = JSON.stringify(credentials);
    if (this.cached?.secret === secret) return this.cached.provider;
    const { adapter } = await YouTubeAdapter.connect(credentials.cookie, credentials.accountIndex, credentials.channelId);
    if (adapter.identity !== credentials.identity) throw new ReviewRequired('The active YouTube account has changed. Reconnect and start a transfer for the intended account.');
    this.cached = { secret, provider: adapter }; return adapter;
  }
}
