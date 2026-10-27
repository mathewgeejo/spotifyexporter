import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import staticFiles from '@fastify/static';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from './config.js';
import { Store, hash, now } from './store.js';
import { Vault } from './security.js';
import { importUpload } from './importer.js';
import { YouTubeAdapter, YouTubeFactory, ProviderError, ReviewRequired, type MusicProvider, type YouTubeCredentials } from './youtube.js';
import { SpotifyAdapter } from './spotify.js';
import { Worker, createTransfer, selectedEntities } from './worker.js';
import type { TransferSelection } from '../shared/types.js';

const selectionSchema = z.object({ collectionIds: z.array(z.string()).max(10000), likes: z.boolean(), songs: z.boolean(), albums: z.boolean(), artists: z.boolean(), favoriteIds: z.array(z.string()).max(200) });
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30), q: z.string().max(200).default('') });
function pagination(query: unknown) { const { page, pageSize, q } = pageQuery.parse(query); return { page, pageSize, q, offset: (page - 1) * pageSize }; }
export function csvRow(values: unknown[]): string {
  return values.map(value => {
    let cell = String(value ?? ''); if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replaceAll('"', '""')}"`;
  }).join(',') + '\r\n';
}

export async function createApp(options: { dataDir?: string; providerFactory?: () => Promise<MusicProvider>; startWorker?: boolean } = {}) {
  const store = new Store(options.dataDir || config.dataDir); const vault = new Vault(store); const factory = new YouTubeFactory(vault);
  const spotify = new SpotifyAdapter(store, vault); const getProvider = options.providerFactory || (() => factory.get());
  const worker = new Worker(store, getProvider, spotify); let importing = false;
  const app = Fastify({ logger: { level: 'warn', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body', 'res.headers.set-cookie'] }, bodyLimit: 65536, requestTimeout: 300000 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 0 } });
  await app.register(swagger, { openapi: { info: { title: 'Encore API', version: '1.1.0', description: 'Local music migration workspace. GET /api/auth/status opens a browser session without a login and returns the x-csrf-token required for writes.' }, components: { securitySchemes: { workspaceSession: { type: 'apiKey', in: 'cookie', name: 'encore_session' } } }, security: [{ workspaceSession: [] }] } });
  const selectionBody = { type: 'object', required: ['collectionIds', 'likes', 'songs', 'albums', 'artists', 'favoriteIds'], properties: { collectionIds: { type: 'array', items: { type: 'string' }, maxItems: 10000 }, likes: { type: 'boolean' }, songs: { type: 'boolean' }, albums: { type: 'boolean' }, artists: { type: 'boolean' }, favoriteIds: { type: 'array', items: { type: 'string' }, maxItems: 200 } } };
  const inputSchemas: Record<string, any> = {
    '/api/connections/spotify': { type: 'object', required: ['cookie'], properties: { cookie: { type: 'string', minLength: 20, maxLength: 32000, description: 'Spotify sp_dc cookie or full Cookie header from open.spotify.com. Stored encrypted.' } } },
    '/api/connections/youtube': { type: 'object', required: ['cookie'], properties: { cookie: { type: 'string', minLength: 20, maxLength: 32000, description: 'Cookie request-header value from the intended YouTube Music account. Stored encrypted; never returned.' }, accountIndex: { type: 'integer', minimum: 0, maximum: 20, default: 0 }, channelId: { type: 'string', description: 'Optional YouTube channel or brand-account ID.' } } },
    '/api/matches': selectionBody, '/api/transfers': selectionBody,
    '/api/matches/:id/search': { type: 'object', required: ['query'], properties: { query: { type: 'string', minLength: 2, maxLength: 300 } } },
    '/api/matches/:id': { type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['approve', 'skip', 'reset'] }, candidateId: { type: 'string' } } },
    '/api/data': { type: 'object', required: ['confirmation'], properties: { confirmation: { type: 'string', const: 'DELETE MY IMPORTED DATA' } } },
  };
  app.addHook('onRoute', route => {
    const method = String(route.method);
    if (['POST', 'PATCH', 'DELETE'].includes(method) && inputSchemas[route.url]) route.schema = { ...route.schema, body: inputSchemas[route.url] };
    if (['POST', 'PATCH', 'DELETE'].includes(method)) route.schema = { ...route.schema, headers: { type: 'object', properties: { 'x-csrf-token': { type: 'string', description: 'CSRF token returned by GET /api/auth/status.' } }, required: ['x-csrf-token'] } };
  });
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]; if (!path.startsWith('/api')) return;
    reply.header('Cache-Control', 'no-store');
    if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Request origin is not allowed.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      const devOrigin = process.env.NODE_ENV !== 'production' && (origin === 'http://127.0.0.1:5173' || origin === 'http://localhost:5173');
      if ((origin && origin !== new URL(config.appUrl).origin && !devOrigin) || request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: 'Request origin is not allowed.' });
    }
    if (path === '/api/auth/status') return;
    const token = request.cookies.encore_session;
    const session = token ? store.get('SELECT * FROM sessions WHERE id=? AND expires>?', hash(token), Date.now()) : undefined;
    if (!session) return reply.code(401).send({ error: 'Open the workspace to initialize a session, then try again.' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-csrf-token'] !== session.csrf) return reply.code(403).send({ error: 'Session verification failed. Reload and try again.' });
  });
  app.setErrorHandler((error: any, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    if (error instanceof ProviderError) return reply.code(error.status === 400 || error.status === 422 ? 400 : error.status === 401 || error.status === 403 ? 409 : 502).send({ error: error.message });
    if (error instanceof ReviewRequired) return reply.code(409).send({ error: error.message });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: error.message });
    return reply.code(500).send({ error: 'The request could not be completed. Check the installation and try again.' });
  });
  const fail = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const openSession = (reply: any) => {
    const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
    store.run('DELETE FROM sessions WHERE expires<?', Date.now());
    store.run('INSERT INTO sessions VALUES (?,?,?)', hash(token), csrf, Date.now() + 7 * 86400000);
    reply.setCookie('encore_session', token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: 7 * 86400 });
    return { authenticated: true, setupRequired: false, csrf };
  };
  app.get('/api/auth/status', { schema: { tags: ['Workspace'], summary: 'Open or renew the local workspace session without a login', security: [] } }, async (request, reply) => {
    const session = request.cookies.encore_session ? store.get('SELECT csrf FROM sessions WHERE id=? AND expires>?', hash(request.cookies.encore_session), Date.now()) : undefined;
    return session ? { authenticated: true, setupRequired: false, csrf: session.csrf } : openSession(reply);
  });
  app.post('/api/auth/logout', async (request, reply) => { if (request.cookies.encore_session) store.run('DELETE FROM sessions WHERE id=?', hash(request.cookies.encore_session)); reply.clearCookie('encore_session', { path: '/' }); return { ok: true }; });

  app.get('/api/overview', { schema: { tags: ['Library'], summary: 'Library counts and recent jobs' } }, async () => ({
    counts: {
      playlists: store.get('SELECT COUNT(*) n FROM collections')!.n,
      songs: store.get("SELECT COUNT(*) n FROM entities WHERE kind='song'")!.n,
      likes: store.get("SELECT COUNT(*) n FROM entities WHERE kind='song' AND json_extract(body,'$.liked')=1")!.n,
      albums: store.get("SELECT COUNT(*) n FROM entities WHERE kind='album' AND json_extract(body,'$.saved')=1")!.n,
      artists: store.get("SELECT COUNT(*) n FROM entities WHERE kind='artist' AND json_extract(body,'$.followed')=1")!.n,
      history: store.get('SELECT COUNT(*) n FROM history')!.n,
      matched: store.get("SELECT COUNT(*) n FROM entities WHERE status='matched'")!.n,
      review: store.get("SELECT COUNT(*) n FROM entities WHERE status IN ('review','missing')")!.n,
      pending: store.get("SELECT COUNT(*) n FROM entities WHERE status='pending'")!.n,
    }, imports: store.all('SELECT id,name,created,stats FROM imports ORDER BY created DESC').map(r => ({ ...r, stats: JSON.parse(r.stats) })),
    jobs: store.all('SELECT * FROM jobs ORDER BY created DESC LIMIT 10').map(row => store.jobView(row)),
  }));
  app.post('/api/imports', { schema: { tags: ['Imports'], summary: 'Upload a Spotify ZIP or JSON file', consumes: ['multipart/form-data'] } }, async request => {
    if (importing) throw fail('Another file import is still processing.', 409);
    const file = await request.file(); if (!file) throw fail('Choose a ZIP or JSON file.');
    const directory = join(store.directory, 'tmp', 'uploads'); await mkdir(directory, { recursive: true });
    const upload = join(directory, randomUUID()); importing = true;
    try {
      await pipeline(file.file, createWriteStream(upload, { flags: 'wx', mode: 0o600 }));
      if (file.file.truncated) throw fail('The upload exceeded 512 MB.', 413);
      try { return await importUpload(store, upload, basename(file.filename)); }
      catch (error: any) { throw fail(error.message.startsWith('Unexpected') ? 'The file contains invalid JSON. No data was committed.' : error.message); }
    } finally { importing = false; await rm(upload, { force: true }); }
  });
  app.get('/api/library/collections', { schema: { tags: ['Library'], summary: 'List imported playlists' } }, async () => store.collections());
  app.get('/api/library/collections/:id', { schema: { tags: ['Library'], summary: 'Browse ordered playlist entries' } }, async request => {
    const { id } = request.params as { id: string }; const p = pagination(request.query);
    if (!store.get('SELECT id FROM collections WHERE id=?', id)) throw fail('Playlist not found.', 404);
    const items = store.all('SELECT e.*,n.position FROM entries n JOIN entities e ON e.id=n.entity_id WHERE n.collection_id=? ORDER BY n.position LIMIT ? OFFSET ?', id, p.pageSize, p.offset).map(r => ({ ...store.entityView(r), position: r.position }));
    return { items, total: store.get('SELECT COUNT(*) n FROM entries WHERE collection_id=?', id)!.n, page: p.page, pageSize: p.pageSize };
  });
  app.get('/api/library/entities', { schema: { tags: ['Library'], summary: 'Browse source records and match decisions' } }, async request => {
    const p = pagination(request.query); const query = z.object({ kind: z.enum(['song', 'album', 'artist']).optional(), status: z.enum(['pending', 'matched', 'review', 'missing', 'skipped']).optional(), liked: z.enum(['true']).optional(), saved: z.enum(['true']).optional(), followed: z.enum(['true']).optional() }).parse(request.query);
    const clauses = ['name LIKE ?']; const params: any[] = [`%${p.q}%`];
    if (query.kind) { clauses.push('kind=?'); params.push(query.kind); }
    if (query.status) { clauses.push('status=?'); params.push(query.status); }
    for (const field of ['liked', 'saved', 'followed'] as const) if (query[field]) clauses.push(`json_extract(body,'$.${field}')=1`);
    const where = clauses.join(' AND ');
    return { items: store.all(`SELECT * FROM entities WHERE ${where} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`, ...params, p.pageSize, p.offset).map(r => store.entityView(r)), total: store.get(`SELECT COUNT(*) n FROM entities WHERE ${where}`, ...params)!.n, page: p.page, pageSize: p.pageSize };
  });
  app.get('/api/connections', { schema: { tags: ['Connections'], summary: 'Read account names without credentials' } }, async () => {
    const yt = vault.get<YouTubeCredentials>('youtube'); const sp = vault.get<any>('spotify');
    return { youtube: { connected: !!yt, account: yt?.account, channelId: yt?.channelId }, spotify: { configured: !!config.spotifyClientId, connected: !!sp, account: sp?.account, mode: sp ? sp.mode || 'oauth' : undefined } };
  });
  app.post('/api/connections/spotify', { schema: { tags: ['Connections'], summary: 'Connect a Spotify Free or Premium web-player session without a developer app' } }, async request => {
    if (worker.isBusy || store.get("SELECT id FROM jobs WHERE status IN ('running','queued')")) throw fail('Pause active jobs and wait for their current request before changing accounts.', 409);
    const { cookie } = z.object({ cookie: z.string().min(20).max(32000) }).parse(request.body);
    const profile = await spotify.connectWeb(cookie);
    return { connected: true, account: profile.account, mode: 'web' };
  });
  app.post('/api/connections/youtube', { schema: { tags: ['Connections'], summary: 'Validate and encrypt a YouTube session cookie' } }, async request => {
    if (worker.isBusy || store.get("SELECT id FROM jobs WHERE status IN ('running','queued')")) throw fail('Pause active jobs and wait for their current request before changing accounts.', 409);
    const body = z.object({ cookie: z.string().min(20).max(32000), accountIndex: z.number().int().min(0).max(20).default(0), channelId: z.string().regex(/^(?:UC[\w-]{22}|\d{21})$/).optional() }).parse(request.body);
    const { credentials } = await YouTubeAdapter.connect(body.cookie.replace(/^cookie:\s*/i, '').trim(), body.accountIndex, body.channelId);
    vault.set('youtube', credentials); factory.clear(); return { connected: true, account: credentials.account };
  });
  app.delete('/api/connections/:provider', { schema: { tags: ['Connections'], summary: 'Disconnect and remove stored provider credentials' } }, async request => {
    const { provider } = z.object({ provider: z.enum(['youtube', 'spotify']) }).parse(request.params);
    store.run("UPDATE jobs SET status='paused',message='Account disconnected. Reconnect before resuming.' WHERE status IN ('running','queued')");
    vault.remove(provider); if (provider === 'spotify') { vault.remove('spotify-pkce'); spotify.clear(); } factory.clear(); return { ok: true };
  });
  app.post('/api/connections/spotify/authorize', { schema: { tags: ['Connections'], summary: 'Start Spotify PKCE authorization' } }, async () => {
    try { return spotify.startAuthorization(); } catch (error: any) { throw fail(error.message); }
  });
  app.get('/api/connections/spotify/callback', { schema: { tags: ['Connections'], summary: 'Complete Spotify authorization' } }, async (request, reply) => {
    const query = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().optional() }).parse(request.query);
    if (query.error || !query.code || !query.state) return reply.redirect(`${config.appUrl}/?spotify=denied`);
    try { await spotify.completeAuthorization(query.code, query.state); } catch { return reply.redirect(`${config.appUrl}/?spotify=failed`); }
    return reply.redirect(`${config.appUrl}/?spotify=connected`);
  });
  app.post('/api/imports/spotify', { schema: { tags: ['Imports'], summary: 'Queue a paginated Spotify snapshot import' } }, async () => {
    const account = vault.get<{ userId: string }>('spotify');
    if (!account) throw fail('Connect Spotify first.');
    if (store.get("SELECT id FROM jobs WHERE kind='spotify_import' AND status IN ('queued','running')")) throw fail('A Spotify import is already in progress. View it in Transfers.', 409);
    return store.job('spotify_import', { userId: account.userId });
  });
  app.post('/api/matches', { schema: { tags: ['Matching'], summary: 'Queue catalog matching for selected collections' } }, async request => {
    const selection = selectionSchema.parse(request.body); const ids = selectedEntities(store, selection);
    if (!ids.length) throw fail('Import and select some music first.');
    if (!vault.get('youtube') && !options.providerFactory) throw fail('Connect YouTube Music before matching.');
    const unresolved = ids.filter(id => !['matched', 'skipped'].includes(store.getEntity(id)?.matchStatus || ''));
    if (!unresolved.length) throw fail('All selected music is already resolved. You can start a transfer.');
    return store.job('match', {}, unresolved.map(sourceId => ({ kind: 'match', sourceId })));
  });
  app.post('/api/matches/:id/search', { schema: { tags: ['Matching'], summary: 'Search for alternative catalog matches' } }, async request => {
    const { id } = request.params as { id: string }; const entity = store.getEntity(id); if (!entity) throw fail('Source record not found.', 404);
    const { query } = z.object({ query: z.string().min(2).max(300) }).parse(request.body);
    const provider = await getProvider(); const results = await provider.search(entity.kind, query);
    const candidates = [...new Map([...results, ...entity.candidates].map(c => [c.id, c])).values()].slice(0, 50);
    store.run('UPDATE entities SET candidates=? WHERE id=?', JSON.stringify(candidates), id); return results;
  });
  app.patch('/api/matches/:id', { schema: { tags: ['Matching'], summary: 'Approve a candidate, skip, or reset a source record' } }, async request => {
    const { id } = request.params as { id: string }; const entity = store.getEntity(id); if (!entity) throw fail('Source record not found.', 404);
    const body = z.object({ action: z.enum(['approve', 'skip', 'reset']), candidateId: z.string().optional() }).parse(request.body);
    const target = entity.candidates.find(c => c.id === body.candidateId);
    if (body.action === 'approve' && !target) throw fail('Search for or select an existing catalog candidate first.');
    store.run('UPDATE entities SET status=?,target=?,reason=? WHERE id=?', body.action === 'approve' ? 'matched' : body.action === 'skip' ? 'skipped' : 'pending', body.action === 'approve' ? JSON.stringify(target) : null, body.action === 'approve' ? 'Approved by owner.' : body.action === 'skip' ? 'Skipped by owner.' : null, id); return { ok: true };
  });
  app.post('/api/transfers', { schema: { tags: ['Transfers'], summary: 'Start a transfer with frozen source and match decisions' } }, async request => {
    const selection = selectionSchema.parse(request.body); const provider = await getProvider();
    try { return createTransfer(store, selection, provider.identity); } catch (error: any) { throw fail(error.message, 409); }
  });
  app.get('/api/jobs', { schema: { tags: ['Transfers'], summary: 'List persisted jobs' } }, async request => {
    const p = pagination(request.query); return { items: store.all('SELECT * FROM jobs ORDER BY created DESC LIMIT ? OFFSET ?', p.pageSize, p.offset).map(row => store.jobView(row)), total: store.get('SELECT COUNT(*) n FROM jobs')!.n, page: p.page, pageSize: p.pageSize };
  });
  app.post('/api/jobs/:id/:action', { schema: { tags: ['Transfers'], summary: 'Pause, resume, cancel, or retry failed job steps' } }, async request => {
    const { id, action } = z.object({ id: z.string(), action: z.enum(['pause', 'resume', 'cancel', 'retry']) }).parse(request.params);
    const job = store.getJob(id); if (!job) throw fail('Job not found.', 404);
    if (action === 'pause') { if (['queued', 'running'].includes(job.status)) store.updateJob(id, 'paused', 'Paused by owner.'); }
    else if (action === 'cancel') { if (!['completed', 'completed_with_issues', 'cancelled'].includes(job.status)) store.updateJob(id, 'cancelled', 'Cancelled. Already transferred music remains in YouTube Music.'); }
    else {
      if (['queued', 'running', 'completed', 'cancelled'].includes(job.status)) throw fail('This job cannot be resumed in its current state.', 409);
      if (action === 'retry') { store.run("UPDATE steps SET status='pending',reason=NULL WHERE job_id=? AND status='failed'", id); store.run('UPDATE jobs SET failed=0 WHERE id=?', id); }
      store.updateJob(id, 'queued', 'Queued to reconcile and continue.');
    }
    return store.getJob(id);
  });
  app.get('/api/jobs/:id/report', { schema: { tags: ['Transfers'], summary: 'Download all per-item outcomes as JSON or CSV' } }, async (request, reply) => {
    const { id } = request.params as { id: string }; const job = store.getJob(id); if (!job) throw fail('Job not found.', 404);
    const { format } = z.object({ format: z.enum(['json', 'csv']).default('json') }).parse(request.query);
    reply.header('Content-Disposition', `attachment; filename="encore-report-${id}.${format}"`);
    function* rows() {
      if (format === 'csv') yield csvRow(['operation', 'source', 'playlist_position', 'status', 'reason', 'destination']); else yield `{"job":${JSON.stringify(job)},"items":[`;
      let first = true; let offset = 0;
      while (true) {
        const batch = store.all('SELECT * FROM steps WHERE job_id=? ORDER BY seq LIMIT 500 OFFSET ?', id, offset); if (!batch.length) break;
        for (const row of batch) {
          const source = row.kind === 'match' ? store.getEntity(row.source_id) : JSON.parse(row.source_id);
          const item = { operation: row.kind, name: source?.entity?.name || source?.name || row.source_id, position: source?.position, status: row.status, reason: row.reason, url: row.url };
          if (format === 'csv') yield csvRow([item.operation, item.name, item.position, item.status, item.reason, item.url]);
          else { yield `${first ? '' : ','}${JSON.stringify(item)}`; first = false; }
        }
        offset += batch.length;
      }
      if (format === 'json') yield ']}';
    }
    reply.type(format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json'); return reply.send(Readable.from(rows()));
  });
  app.get('/api/history', { schema: { tags: ['History'], summary: 'Browse dated listening events with search and date filters' } }, async request => {
    const p = pagination(request.query); const dates = z.object({ from: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional(), to: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional() }).parse(request.query);
    const clauses = ['e.name LIKE ?']; const params: any[] = [`%${p.q}%`];
    if (dates.from) { clauses.push('h.played_at>=?'); params.push(`${dates.from}T00:00:00.000Z`); }
    if (dates.to) { const end = new Date(`${dates.to}T00:00:00Z`); if (Number.isNaN(end.getTime())) throw fail('Invalid date.'); end.setUTCDate(end.getUTCDate() + 1); clauses.push('h.played_at<?'); params.push(end.toISOString()); }
    const where = clauses.join(' AND ');
    const summary = store.get(`SELECT COUNT(*) total,COALESCE(SUM(h.ms_played),0) milliseconds FROM history h JOIN entities e ON h.entity_id=e.id WHERE ${where}`, ...params)!;
    return { ...summary, page: p.page, pageSize: p.pageSize, items: store.all(`SELECT h.*,e.body FROM history h JOIN entities e ON h.entity_id=e.id WHERE ${where} ORDER BY h.played_at DESC LIMIT ? OFFSET ?`, ...params, p.pageSize, p.offset).map(r => ({ id: r.id, entity: JSON.parse(r.body), playedAt: r.played_at, msPlayed: r.ms_played, skipped: !!r.skipped, source: r.source })) };
  });
  const favorites = () => store.all('SELECT e.*,SUM(h.ms_played) milliseconds,COUNT(*) plays FROM history h JOIN entities e ON h.entity_id=e.id WHERE h.skipped=0 AND h.ms_played>=30000 GROUP BY e.id ORDER BY milliseconds DESC LIMIT 50').map(r => ({ ...store.entityView(r), milliseconds: r.milliseconds, plays: r.plays }));
  app.get('/api/history/favorites', { schema: { tags: ['History'], summary: 'Suggest favorites ranked by qualified listening time' } }, async () => favorites());
  app.post('/api/history/playlist', { schema: { tags: ['History'], summary: 'Create a source playlist of your 50 most-played songs' } }, async () => {
    const top = favorites(); if (!top.length) throw fail('Import history with listening durations to generate this playlist.');
    const ids = top.map(e => e.id); const id = store.collection(`history:most-played:${hash(JSON.stringify(ids))}`, { name: 'Most Played on Spotify', description: 'Your most-played Spotify songs, ranked by total listening time. Skips and plays under 30 seconds excluded.', generated: true }, ids);
    return { id };
  });
  app.get('/api/export', { schema: { tags: ['Exports'], summary: 'Export music records or history without credentials' } }, async (request, reply) => {
    const query = z.object({ format: z.enum(['json', 'csv']).default('json'), type: z.enum(['library', 'history']).default('library') }).parse(request.query);
    const history = query.type === 'history'; reply.header('Content-Disposition', `attachment; filename="encore-${query.type}.${query.format}"`);
    function* output() {
      if (query.format === 'csv') yield history ? csvRow(['track', 'artists', 'played_at_utc', 'ms_played', 'skipped', 'source']) : csvRow(['kind', 'name', 'artists', 'album', 'spotify_uri', 'liked', 'saved', 'followed', 'match_status', 'destination']);
      else yield history ? '{"history":[' : `{"version":1,"collections":${JSON.stringify(store.collections())},"entities":[`;
      let offset = 0; let first = true;
      while (true) {
        const batch = history ? store.all('SELECT h.*,e.body FROM history h JOIN entities e ON h.entity_id=e.id ORDER BY h.played_at LIMIT 500 OFFSET ?', offset) : store.all('SELECT * FROM entities ORDER BY id LIMIT 500 OFFSET ?', offset);
        if (!batch.length) break;
        for (const row of batch) {
          const entity = history ? JSON.parse(row.body) : store.entityView(row);
          const item = history ? { entity, playedAt: row.played_at, msPlayed: row.ms_played, skipped: !!row.skipped, source: row.source } : entity;
          if (query.format === 'json') { yield `${first ? '' : ','}${JSON.stringify(item)}`; first = false; }
          else yield history ? csvRow([entity.name, entity.artists.join('; '), row.played_at, row.ms_played, !!row.skipped, row.source]) : csvRow([entity.kind, entity.name, entity.artists.join('; '), entity.album, entity.uri, entity.liked, entity.saved, entity.followed, entity.matchStatus, entity.target?.url]);
        }
        offset += batch.length;
      }
      if (query.format === 'json') {
        yield ']';
        if (!history) {
          yield ',"entries":['; let firstEntry = true; let entryOffset = 0;
          while (true) { const batch = store.all('SELECT collection_id AS collectionId,position,entity_id AS entityId FROM entries ORDER BY collection_id,position LIMIT 500 OFFSET ?', entryOffset); if (!batch.length) break;
            for (const row of batch) { yield `${firstEntry ? '' : ','}${JSON.stringify(row)}`; firstEntry = false; } entryOffset += batch.length;
          } yield ']';
        } yield '}';
      }
    }
    reply.type(query.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json'); return reply.send(Readable.from(output()));
  });
  app.delete('/api/data', { schema: { tags: ['Owner'], summary: 'Delete all imported music, reports, and migration mappings' } }, async request => {
    const { confirmation } = z.object({ confirmation: z.literal('DELETE MY IMPORTED DATA') }).parse(request.body);
    if (importing || worker.isBusy || store.get("SELECT id FROM jobs WHERE status IN ('running','queued')")) throw fail('Wait for imports and pause active jobs before deleting data.', 409);
    store.transaction(() => { for (const table of ['jobs', 'destinations', 'history', 'entries', 'collections', 'entities', 'imports']) store.db.exec(`DELETE FROM ${table}`); });
    await rm(join(store.directory, 'imports'), { recursive: true, force: true }); return { ok: true };
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  const dist = resolve('dist');
  if (existsSync(join(dist, 'index.html'))) {
    await app.register(staticFiles, { root: dist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api') ? reply.code(404).send({ error: 'Endpoint not found.' }) : reply.sendFile('index.html'));
  } else app.get('/', async () => ({ app: 'Encore', message: 'Development UI: http://127.0.0.1:5173. Production UI is created by npm run build.' }));
  app.addHook('onClose', async () => { await worker.stop(); store.close(); });
  if (options.startWorker !== false) worker.start();
  return { app, store, vault, worker };
}
