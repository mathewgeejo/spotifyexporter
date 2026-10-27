import { createHmac, randomUUID } from 'node:crypto';
import type { SourceEntity } from '../shared/types.js';
import { ProviderError } from './youtube.js';

const PLAYER = 'https://open.spotify.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SECRET_URL = 'https://code.thetadev.de/ThetaDev/spotify-secrets/raw/branch/main/secrets/secretDict.json';
type Request = typeof fetch;
type PlayerMetadata = { clientVersion: string; serverTime: number; hashes: Record<string, string> };
export interface SpotifyWebCredentials { mode: 'web'; cookie: string; account: string; userId: string }

// Accept the sp_dc value or a Cookie header, retaining only the Spotify session cookie.
export function spotifyCookie(input: string): string {
  const value = input.trim().replace(/^cookie:\s*/i, '');
  const match = value.match(/(?:^|;\s*)sp_dc=([^;\s]+)/);
  const session = match?.[1] || (/^[\w%+./~-]+={0,2}$/.test(value) ? value : '');
  if (!session || session.length < 20 || session.length > 4096 || /[^\x21-\x7e]|[;"\\]/.test(session)) {
    throw new ProviderError('Paste the sp_dc cookie from open.spotify.com, or its full Cookie request header.', 400);
  }
  return `sp_dc=${session}`;
}

export function spotifyTotp(cipher: number[], seconds: number): string {
  // Spotify's public web-player challenge; the secret rotates independently of account credentials.
  const key = Buffer.from(cipher.map((byte, index) => byte ^ ((index % 33) + 9)).join(''));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

export function playerConfig(html: string): { clientVersion: string; serverTime: number } {
  const encoded = html.match(/<script\b[^>]*\bid=["']appServerConfig["'][^>]*>([\s\S]*?)<\/script>/)?.[1];
  try {
    const parsed = JSON.parse(Buffer.from(encoded || '', 'base64').toString('utf8'));
    if (typeof parsed.clientVersion === 'string' && Number.isFinite(parsed.serverTime)) return parsed;
  } catch { /* Report a stable, credential-free error below. */ }
  throw new ProviderError('Spotify changed its web-player configuration. Use an Account data export while the connector is updated.', 422);
}

export function queryHashes(script: string): Record<string, string> {
  return Object.fromEntries([...script.matchAll(/["'](\w+)["'],\s*["']query["'],\s*["']([a-f0-9]{64})["']/g)].map(m => [m[1], m[2]]));
}

export function webSong(record: any, flags: Partial<SourceEntity> = {}): Omit<SourceEntity, 'id'> | undefined {
  const wrapper = record?.itemV2 || record?.track || record?.item || record;
  const track = wrapper?.data || wrapper;
  if (!track || !['Track', 'LocalTrack'].includes(track.__typename)) return;
  const artistList = track.artists?.items || track.artists;
  const artists = (Array.isArray(artistList) ? artistList : []).map((artist: any) => typeof artist === 'string' ? artist : artist?.profile?.name || artist?.name).filter(Boolean);
  const local = track.__typename === 'LocalTrack' || !!track.isLocal || String(track.uri || wrapper?._uri).startsWith('spotify:local:');
  if (!track.name || (!artists.length && !local)) return;
  const duration = track.trackDuration?.totalMilliseconds ?? track.duration?.totalMilliseconds ?? track.duration?.milliseconds;
  return { kind: 'song', name: track.name, artists, uri: track.uri || wrapper?._uri,
    album: track.albumOfTrack?.name || track.album?.name, durationMs: Number.isFinite(duration) ? duration : undefined,
    explicit: track.contentRating?.label ? track.contentRating.label === 'EXPLICIT' : undefined, local, ...flags };
}

export class SpotifyWebClient {
  private metadata?: PlayerMetadata;
  private metadataExpires = 0;
  private token?: { value: string; clientId: string; expires: number };
  private clientToken?: { value: string; expires: number };
  private readonly deviceId = randomUUID();
  constructor(private readonly cookie: string, private readonly request: Request = fetch) {}

  private async send(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try { response = await this.request(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...init.headers }, signal: AbortSignal.timeout(30000), redirect: 'error' }); }
    catch { throw new ProviderError('Could not reach Spotify. Check your connection and resume the import.', 502); }
    if (response.status === 400 && response.headers.get('client-token-error') === 'INVALID_CLIENTTOKEN') {
      this.clientToken = undefined;
      throw new ProviderError('Spotify browser token expired. Refreshing the connection.', 401);
    }
    if (!response.ok) throw new ProviderError(response.status === 401 || response.status === 403
      ? 'Spotify rejected this browser session. Copy a fresh sp_dc cookie from the web player and reconnect.'
      : response.status === 429 ? 'Spotify is rate limiting this import. Wait, then resume it from Transfers.'
        : 'Spotify could not complete the request. Resume the import to try again.', response.status, Number(response.headers.get('retry-after')) || 0);
    return response;
  }
  private async json(response: Response): Promise<any> {
    try { return await response.json(); }
    catch { throw new ProviderError('Spotify returned an unexpected response. Reconnect or use an Account data export.', 422); }
  }
  private async player(force = false): Promise<PlayerMetadata> {
    if (!force && this.metadata && this.metadataExpires > Date.now()) return this.metadata;
    const html = await (await this.send(`${PLAYER}/`, { headers: { Cookie: this.cookie } })).text();
    const config = playerConfig(html);
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
    const main = scripts.find(link => /^https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[\w-]+\.js$/.test(link));
    if (!main) throw new ProviderError('Spotify changed its web-player scripts. Use an Account data export while the connector is updated.', 422);
    let source = await (await this.send(main)).text();
    const hashes = queryHashes(source);
    const required = ['profileAttributes', 'libraryV3', 'fetchPlaylist', 'fetchLibraryTracks'];
    // Some player releases move query documents into webpack chunks. Read data only; never execute downloaded code.
    if (required.some(name => !hashes[name])) {
      const maps: Record<string, string>[] = [...source.matchAll(/\{\d+:"[^"]+"(?:,\d+:"[^"]+")*\}/g)]
        .map(match => JSON.parse(match[0].replace(/([{,])(\d+):/g, '$1"$2":')));
      const names = maps.find(map => Object.values(map).some(value => value.includes('xpui-')));
      const digests = maps.find(map => Object.values(map).length > 20 && Object.values(map).every(value => /^[a-f0-9]{8,64}$/.test(value)));
      if (names && digests) {
        const chunks = Object.entries(names).filter(([id, name]) => digests[id] && /library|playlist|collection|profile|shared/.test(name)).slice(0, 30);
        for (const [id, name] of chunks) {
          if (!/^[\w~-]+$/.test(name)) continue;
          source = await (await this.send(`https://open.spotifycdn.com/cdn/build/web-player/${name}.${digests[id]}.js`)).text();
          Object.assign(hashes, queryHashes(source));
          if (required.every(name => hashes[name])) break;
        }
      }
    }
    if (required.some(name => !hashes[name])) throw new ProviderError('Spotify changed its library queries. Use an Account data export while the connector is updated.', 422);
    this.metadata = { ...config, hashes }; this.metadataExpires = Date.now() + 15 * 60000;
    return this.metadata;
  }
  private async authorize(force = false) {
    if (force) { this.token = undefined; this.clientToken = undefined; }
    const metadata = await this.player();
    if (!this.token || this.token.expires < Date.now() + 30000) {
      const secrets = await this.json(await this.send(SECRET_URL));
      if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new ProviderError('The Spotify web-player challenge could not be refreshed. Use an Account data export for now.', 422);
      const version = Object.keys(secrets).filter(key => /^\d+$/.test(key)).sort((a, b) => Number(b) - Number(a))[0];
      const cipher = secrets[version];
      if (!Array.isArray(cipher) || cipher.length < 10 || cipher.length > 256 || cipher.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
        throw new ProviderError('The Spotify web-player challenge could not be refreshed. Use an Account data export for now.', 422);
      }
      // Obtain current server time even when the cached player metadata is older than a TOTP period.
      const time = await this.json(await this.send(`${PLAYER}/api/server-time`));
      const seconds = time.serverTime;
      if (!Number.isFinite(seconds) || seconds <= 0) throw new ProviderError('Spotify did not return a valid server time.', 422);
      const code = spotifyTotp(cipher, seconds);
      const query = new URLSearchParams({ reason: 'init', productType: 'web-player', totp: code, totpVer: version, totpServer: code });
      const token = await this.json(await this.send(`${PLAYER}/api/token?${query}`, { headers: { Cookie: this.cookie, Referer: `${PLAYER}/` } }));
      if (token.isAnonymous !== false || !token.accessToken || !token.clientId || !Number.isFinite(token.accessTokenExpirationTimestampMs)) {
        throw new ProviderError('Spotify did not recognize this session. Copy sp_dc from a signed-in open.spotify.com tab.', 401);
      }
      this.token = { value: token.accessToken, clientId: token.clientId, expires: token.accessTokenExpirationTimestampMs };
    }
    if (!this.clientToken || this.clientToken.expires < Date.now() + 30000) {
      const result = await this.json(await this.send('https://clienttoken.spotify.com/v1/clienttoken', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({
        client_data: { client_version: metadata.clientVersion, client_id: this.token.clientId,
          js_sdk_data: { device_brand: 'unknown', device_model: 'unknown', os: 'windows', os_version: 'NT 10.0', device_id: this.deviceId, device_type: 'computer' } },
      }) }));
      if (!result.granted_token?.token) throw new ProviderError('Spotify requested a browser verification. Open the Spotify web player, then copy a fresh cookie and reconnect.', 401);
      this.clientToken = { value: result.granted_token.token, expires: Date.now() + (result.granted_token.expires_after_seconds || 3600) * 1000 };
    }
    return { metadata, token: this.token, clientToken: this.clientToken };
  }
  async query(name: string, variables: Record<string, unknown>, retry = true): Promise<any> {
    try {
      const auth = await this.authorize();
      const response = await this.send('https://api-partner.spotify.com/pathfinder/v2/query', {
        method: 'POST', headers: { Authorization: `Bearer ${auth.token.value}`, 'Client-Token': auth.clientToken.value, 'Spotify-App-Version': auth.metadata.clientVersion,
          'App-Platform': 'WebPlayer', 'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json', Origin: PLAYER, Referer: `${PLAYER}/` },
        body: JSON.stringify({ operationName: name, variables, extensions: { persistedQuery: { version: 1, sha256Hash: auth.metadata.hashes[name] } } }),
      });
      const result = await this.json(response);
      if (result.errors?.length) {
        const stale = result.errors.some((error: any) => /persistedquery|persisted query/i.test(error.message || ''));
        if (stale && retry) { await this.player(true); return this.query(name, variables, false); }
        const denied = result.errors.some((error: any) => /unauthenticated|unauthorized|not authorized/i.test(error.message || error.extensions?.code || ''));
        throw new ProviderError(denied ? 'Spotify session expired. Reconnect using a fresh sp_dc cookie.' : 'Spotify could not read this collection. Reconnect or import an Account data export.', denied ? 401 : 422);
      }
      if (!result.data) throw new ProviderError('Spotify returned no library data. Reconnect or use an Account data export.', 422);
      return result.data;
    } catch (error) {
      if (retry && error instanceof ProviderError && error.status === 401) { await this.authorize(true); return this.query(name, variables, false); }
      throw error;
    }
  }
  async profile(): Promise<{ account: string; userId: string }> {
    const result = await this.query('profileAttributes', {}); const profile = result.me?.profile;
    if (!profile?.username) throw new ProviderError('Spotify could not identify your account. Copy a fresh browser session cookie.', 401);
    return { userId: profile.username, account: profile.name || profile.username };
  }
  async *pages(name: string, variables: Record<string, unknown>, select: (data: any) => any, check: () => void): AsyncGenerator<any> {
    let offset = 0;
    while (true) {
      check(); const data = await this.query(name, { ...variables, offset, limit: 100 }); check();
      const page = select(data);
      if (!page || !Array.isArray(page.items) || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0) {
        throw new ProviderError('Spotify changed the collection response. No incomplete playlist was saved; try an Account data export.', 422);
      }
      if (page.pagingInfo?.offset !== undefined && page.pagingInfo.offset !== offset) throw new ProviderError('Spotify returned a repeated or out-of-order page. Resume the import to try again.', 502);
      if (!page.items.length && offset < page.totalCount) throw new ProviderError('Spotify returned an incomplete collection. Resume the import to try again.', 502);
      yield page;
      offset += page.items.length;
      if (offset >= page.totalCount) break;
    }
  }
}
