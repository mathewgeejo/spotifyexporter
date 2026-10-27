import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowRightLeft, ArrowUpRight, CheckCircle2, ChevronLeft, ChevronRight, Clock3, Download, ExternalLink, Headphones, Heart, Library, ListMusic, Menu, Music2, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, X, CircleAlert, LayoutDashboard, ScanSearch, RefreshCw } from 'lucide-react';
import { api, ApiError, setCsrf } from './api.js';
import OverviewScreen from './components/OverviewScreen.js';
import SettingsScreen from './components/SettingsScreen.js';
import TransferCounts from './components/TransferCounts.js';
import { Badge, Cover, Modal, Spinner } from './components/ui.js';
import type { Screen, Overview } from './types.js';
import type { Collection, ConnectionStatus, EntityView, Job, Page, TransferSelection } from '../shared/types.js';

const number = (value = 0) => new Intl.NumberFormat().format(value);
const duration = (ms = 0) => ms >= 3600000 ? `${(ms / 3600000).toFixed(1)} hr` : `${Math.round(ms / 60000)} min`;
const date = (value: string) => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const active = (job: Job) => ['queued', 'running'].includes(job.status);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Try again.';

function Brand({ small = false }: { small?: boolean }) { return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-mark"><ArrowRightLeft size={21}/></span><span>encore<span className="brand-period">.</span></span></div>; }
function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) { return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{children}</p></div>; }
function Pager({ page, total, size, change }: { page: number; total: number; size: number; change: (value: number) => void }) {
  if (!total) return null;
  return <div className="pager"><span>{number((page - 1) * size + 1)}–{number(Math.min(page * size, total))} of {number(total)}</span><div><button className="icon-button" aria-label="Previous page" disabled={page === 1} onClick={() => change(page - 1)}><ChevronLeft size={18}/></button><button className="icon-button" aria-label="Next page" disabled={page * size >= total} onClick={() => change(page + 1)}><ChevronRight size={18}/></button></div></div>;
}
export default function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const opening = useRef<Promise<{ csrf: string }> | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      opening.current ??= api('/api/auth/status');
      opening.current.then(data => { if (!disposed) { setCsrf(data.csrf); setError(''); setReady(true); } }).catch(error => {
        if (disposed) return;
        opening.current = undefined;
        setError(errorMessage(error));
        if (error instanceof ApiError && error.code === 'SERVER_UNAVAILABLE') timer = setTimeout(open, 2500);
      });
    };
    open();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  if (!ready) return <div className="boot"><Brand/><p>{error || <><Spinner/> Opening your music workspace…</>}</p>{error && <button className="btn" onClick={() => location.reload()}>Try again</button>}</div>;
  return <Workspace/>;
}

function Workspace() {
  const [screen, setScreen] = useState<Screen>('overview'); const [mobileNav, setMobileNav] = useState(false);
  const [overview, setOverview] = useState<Overview>(); const [connections, setConnections] = useState<ConnectionStatus>(); const [collections, setCollections] = useState<Collection[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set()); const known = useRef(new Set<string>());
  const [selectionFlags, setSelectionFlags] = useState({ likes: true, songs: true, albums: true, artists: true }); const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; error?: boolean; reconnect?: boolean }>(); const [connectionLost, setConnectionLost] = useState(false); const [busy, setBusy] = useState(false); const [refreshVersion, setRefreshVersion] = useState(0);
  const input = useRef<HTMLInputElement>(null); const refreshBusy = useRef(false);
  const refresh = async () => {
    if (refreshBusy.current) return; refreshBusy.current = true;
    const results = await Promise.allSettled([api<Overview>('/api/overview'), api<ConnectionStatus>('/api/connections'), api<Collection[]>('/api/library/collections')]);
    if (results[0].status === 'fulfilled') setOverview(results[0].value);
    if (results[1].status === 'fulfilled') setConnections(results[1].value);
    if (results[2].status === 'fulfilled') {
      const list = results[2].value; setCollections(list);
      const added = list.filter(c => !known.current.has(c.id) && !c.inaccessible).map(c => c.id);
      setSelected(old => { const next = new Set([...old].filter(id => list.some(c => c.id === id))); for (const id of added) next.add(id); return next; });
      known.current = new Set(list.map(c => c.id));
    }
    setConnectionLost(results.some(result => result.status === 'rejected' && result.reason instanceof ApiError && result.reason.code === 'SERVER_UNAVAILABLE'));
    for (const result of results) if (result.status === 'rejected' && !(result.reason instanceof ApiError && result.reason.code === 'SERVER_UNAVAILABLE')) { setNotice({ text: errorMessage(result.reason), error: true }); break; }
    refreshBusy.current = false;
  };
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2500); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const state = new URLSearchParams(location.search).get('spotify');
    if (state) { setScreen('settings'); setNotice({ text: state === 'connected' ? 'Spotify connected. Import your current library below.' : 'Spotify did not connect. Check your developer app or use an export file.', error: state !== 'connected' }); history.replaceState(null, '', location.pathname); }
  }, []);
  const run = async (fn: () => Promise<unknown>, message?: string) => {
    setBusy(true); try { await fn(); if (message) setNotice({ text: message }); setRefreshVersion(v => v + 1); await refresh(); }
    catch (error) { setNotice({ text: errorMessage(error), error: true, reconnect: error instanceof ApiError && error.code === 'YOUTUBE_RECONNECT_REQUIRED' }); } finally { setBusy(false); }
  };
  const importFiles = async (files: FileList | File[]) => {
    await run(async () => { const messages: string[] = [];
      for (const file of Array.from(files)) {
        const form = new FormData(); form.append('file', file); const result = await api('/api/imports', { method: 'POST', body: form });
        messages.push(result.duplicate ? `${file.name} was already imported.` : `${file.name}: ${result.stats.playlists} playlists, ${result.stats.songs} saved songs, ${number(result.stats.history)} listening events imported.`);
        if (result.stats.warnings.length) messages.push(...result.stats.warnings);
      } setNotice({ text: messages.join(' ') });
    });
  };
  const selection: TransferSelection = { collectionIds: [...selected], ...selectionFlags, favoriteIds: [...favorites] };
  const matching = overview?.jobs.some(job => job.kind === 'match' && active(job));
  const navigate = (value: Screen) => { setScreen(value); setMobileNav(false); };
  const nav: { id: Screen; name: string; icon: ReactNode; count?: number }[] = [
    { id: 'overview', name: 'Overview', icon: <LayoutDashboard size={19}/> }, { id: 'library', name: 'Your collection', icon: <Library size={19}/> },
    { id: 'review', name: 'Review matches', icon: <ScanSearch size={19}/>, count: overview?.counts.review }, { id: 'history', name: 'Listening history', icon: <Clock3 size={19}/> },
    { id: 'transfers', name: 'Transfers', icon: <ArrowRightLeft size={19}/> },
  ];
  const title = nav.find(n => n.id === screen)?.name || 'Connections & settings';
  return <div className="app-shell"><aside className={`sidebar ${mobileNav ? 'open' : ''}`}><Brand/><div className="workspace-label">YOUR WORKSPACE</div><nav>{nav.map(item => <button key={item.id} className={`nav-item ${screen === item.id ? 'selected' : ''}`} onClick={() => navigate(item.id)}>{item.icon}<span>{item.name}</span>{!!item.count && <span className="nav-count">{item.count}</span>}</button>)}</nav><div className="sidebar-bottom"><div className="sidebar-privacy"><ShieldCheck size={16}/><span>Private workspace</span></div><button className={`nav-item ${screen === 'settings' ? 'selected' : ''}`} onClick={() => navigate('settings')}><Settings2 size={19}/><span>Connections & settings</span></button><div className="owner"><span className="avatar">ME</span><div><strong>My workspace</strong></div></div></div></aside>{mobileNav && <button className="nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)}/>}
    <div className="main-shell"><header className="topbar"><div><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={22}/></button><span className="breadcrumb">Workspace <ChevronRight size={13}/> <strong>{title}</strong></span></div><div className="topbar-right"><span className={`local-pill ${connectionLost ? 'reconnecting' : ''}`} role="status" aria-live="polite"><span/> {connectionLost ? 'Reconnecting…' : 'Local'}</span><a className="icon-button" href="/api/export?format=json&type=library" aria-label="Download library backup"><Download size={18}/></a></div></header>
      <main>{!overview || !connections ? <div className="loading"><Spinner/> Loading your collection…</div> : <>
        {screen === 'overview' && <OverviewScreen overview={overview} connections={connections} collections={collections} busy={busy} onImport={() => input.current?.click()} onDrop={importFiles} navigate={navigate} onSync={() => void run(async () => { await api('/api/imports/spotify', { method: 'POST' }); navigate('transfers'); }, 'Spotify import queued.')}/>}
        {screen === 'library' && <LibraryScreen collections={collections} selected={selected} setSelected={setSelected} flags={selectionFlags} setFlags={setSelectionFlags} overview={overview} refreshVersion={refreshVersion} run={run} onImport={() => input.current?.click()}/>}
        {screen === 'review' && <ReviewScreen refreshVersion={refreshVersion} run={run} matching={!!matching} busy={busy} onMatch={() => void run(async () => { await api('/api/matches', { method: 'POST', body: selection }); navigate('transfers'); }, 'Best-match selection queued.')}/>}
        {screen === 'history' && <HistoryScreen refreshVersion={refreshVersion} run={run} favorites={favorites} setFavorites={setFavorites} navigate={navigate}/>}
        {screen === 'transfers' && <TransfersScreen refreshVersion={refreshVersion} run={run} busy={busy}/>}
        {screen === 'settings' && <SettingsScreen connections={connections} run={run} busy={busy} onImport={() => input.current?.click()} navigate={navigate}/>}
      </>}</main>
      {overview && connections && !!(overview.counts.playlists || overview.counts.songs || overview.counts.albums || overview.counts.artists) && ['overview', 'library', 'review', 'history'].includes(screen) && <div className="transfer-bar"><div className="transfer-selection"><span className="selection-icon"><ListMusic size={21}/></span><div><strong>{selected.size} playlists selected</strong><span>{[selectionFlags.likes && 'Likes', selectionFlags.songs && 'Saved songs', selectionFlags.albums && 'Albums', selectionFlags.artists && 'Artists', favorites.size > 0 && `${favorites.size} extra favorites`].filter(Boolean).join(' · ') || 'Playlist transfer only'}</span></div></div><div className="transfer-actions"><button className="btn primary" disabled={busy || !overview.counts.playlists && !overview.counts.likes && !overview.counts.albums && !overview.counts.artists} onClick={() => { if (!connections.youtube.connected) { navigate('settings'); return; } void run(async () => { await api('/api/transfers', { method: 'POST', body: selection }); navigate('transfers'); }, 'Choosing best matches. Your transfer will start automatically.'); }}>{busy ? <Spinner/> : <ArrowRight size={18}/>} {connections.youtube.connected ? 'Start transfer' : 'Connect YouTube Music'}</button></div></div>}
    </div><input ref={input} className="sr-only" type="file" accept=".zip,.json" multiple aria-label="Upload Spotify data" onChange={e => { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }}/>{notice && <div className={`toast ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <CircleAlert size={20}/> : <CheckCircle2 size={20}/>}<span>{notice.text}</span>{notice.reconnect && <button className="btn compact secondary" onClick={() => { navigate('settings'); setNotice(undefined); }}>Reconnect</button>}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(undefined)}><X size={17}/></button></div>}
  </div>;
}
function useData<T>(path: string, version = 0) {
  const [data, setData] = useState<T>(); const [error, setError] = useState('');
  useEffect(() => { const controller = new AbortController(); setError(''); api<T>(path, { signal: controller.signal }).then(setData).catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); }); return () => controller.abort(); }, [path, version]);
  return { data, error };
}
function LibraryScreen({ collections, selected, setSelected, flags, setFlags, overview, refreshVersion, run, onImport }: { collections: Collection[]; selected: Set<string>; setSelected: (value: Set<string>) => void; flags: { likes: boolean; songs: boolean; albums: boolean; artists: boolean }; setFlags: (value: typeof flags) => void; overview: Overview; refreshVersion: number; run: (fn: () => Promise<unknown>, message?: string) => Promise<void>; onImport: () => void }) {
  const [tab, setTab] = useState('playlists'); const [search, setSearch] = useState(''); const [page, setPage] = useState(1); const [preview, setPreview] = useState<Collection>();
  const kind = tab === 'albums' ? 'album' : tab === 'artists' ? 'artist' : 'song';
  const { data, error } = useData<Page<EntityView>>(`/api/library/entities?kind=${kind}&${tab === 'likes' ? 'liked=true' : tab === 'artists' ? 'followed=true' : 'saved=true'}&q=${encodeURIComponent(search)}&page=${page}`, refreshVersion);
  const filtered = collections.filter(c => c.name.toLowerCase().includes(search.toLowerCase()));
  const toggle = (id: string) => { const next = new Set(selected); if (next.has(id)) next.delete(id); else next.add(id); setSelected(next); };
  return <><div className="page-heading"><div><h1>Your collection.</h1></div><button className="btn secondary" onClick={onImport}><Plus size={17}/> Import music</button></div><div className="library-options">{(['likes', 'songs', 'albums', 'artists'] as const).map(key => <label className="check-option" key={key}><input type="checkbox" checked={flags[key]} onChange={e => setFlags({ ...flags, [key]: e.target.checked })}/>{({ likes: 'Transfer native likes', songs: 'Save songs to library', albums: 'Save albums', artists: 'Follow artists' })[key]}</label>)}</div><div className="toolbar"><div className="tabs">{[['playlists', 'Playlists', overview.counts.playlists], ['likes', 'Liked songs', overview.counts.likes], ['songs', 'Saved songs', null], ['albums', 'Albums', overview.counts.albums], ['artists', 'Artists', overview.counts.artists]].map(([id, label, count]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(String(id)); setPage(1); setSearch(''); }}>{label}{count !== null && <span>{number(Number(count))}</span>}</button>)}</div><label className="search-field"><Search size={17}/><input aria-label="Search collection" placeholder="Search your collection" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label></div>
    {tab === 'playlists' ? <><div className="list-heading"><label className="check-option"><input type="checkbox" checked={filtered.filter(c => !c.inaccessible).length > 0 && filtered.filter(c => !c.inaccessible).every(c => selected.has(c.id))} onChange={e => { const next = new Set(selected); filtered.filter(c => !c.inaccessible).forEach(c => e.target.checked ? next.add(c.id) : next.delete(c.id)); setSelected(next); }}/> Select all visible playlists</label><span>{number(selected.size)} selected</span></div>{filtered.length ? <div className="playlist-grid">{filtered.map(collection => <article className={`playlist-card ${selected.has(collection.id) ? 'checked' : ''}`} key={collection.id}><div className="playlist-art"><Cover id={collection.id} name={collection.name}/><label className="cover-checkbox"><input type="checkbox" aria-label={`Transfer ${collection.name}`} disabled={collection.inaccessible} checked={selected.has(collection.id)} onChange={() => toggle(collection.id)}/></label><button className="preview-button" aria-label={`Preview ${collection.name}`} onClick={() => setPreview(collection)}><ListMusic size={20}/></button></div><div className="playlist-info"><span className="eyebrow">{collection.generated ? 'FROM YOUR HISTORY' : 'SPOTIFY PLAYLIST'}</span><h3 title={collection.name}>{collection.name}</h3><p>{collection.inaccessible ? 'Archive needed for playlist contents' : `${number(collection.count)} tracks`}</p><button className="text-button" onClick={() => setPreview(collection)}>View tracks <ArrowUpRight size={14}/></button></div></article>)}</div> : <Empty icon={<Library size={30}/>} title={search ? 'No matches.' : 'No playlists yet.'}>Connect Spotify or import an archive.</Empty>}</> : error ? <div className="inline-error">{error}</div> : !data ? <div className="loading"><Spinner/> Loading records…</div> : data.items.length ? <section className="table-panel"><table><thead><tr><th>{tab === 'artists' ? 'Artist' : 'Name'}</th><th>Artist / album</th><th>Match</th><th>Destination</th></tr></thead><tbody>{data.items.map(entity => <tr key={entity.id}><td><div className="track-name"><Cover id={entity.id} name={entity.name} small/><strong>{entity.name}</strong></div></td><td>{entity.artists.join(', ')}{entity.album && <small>{entity.album}</small>}</td><td><Badge status={entity.matchStatus}/></td><td>{entity.target ? <a className="text-button" href={entity.target.url} target="_blank" rel="noreferrer">Open <ExternalLink size={13}/></a> : <span className="muted">—</span>}</td></tr>)}</tbody></table><Pager page={page} total={data.total} size={data.pageSize} change={setPage}/></section> : <Empty icon={<Music2 size={30}/>} title="Nothing here yet.">Import your Spotify library to get started.</Empty>}
    {preview && <PlaylistPreview collection={preview} onClose={() => setPreview(undefined)}/>}
  </>;
}
function PlaylistPreview({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const [page, setPage] = useState(1); const { data, error } = useData<Page<EntityView & { position: number }>>(`/api/library/collections/${collection.id}?page=${page}`);
  return <Modal title={collection.name} onClose={onClose}><p className="muted">{collection.description || 'An imported Spotify playlist.'}</p><p className="fine-print">Original order and repeated songs are preserved.</p>{error && <p className="inline-error">{error}</p>}{!data ? <div className="loading"><Spinner/></div> : <><div className="preview-tracks">{data.items.map(entity => <div key={entity.position}><span>{entity.position + 1}</span><div><strong>{entity.name}</strong><small>{entity.artists.join(', ')}</small></div><Badge status={entity.matchStatus}/></div>)}</div><Pager page={page} total={data.total} size={data.pageSize} change={setPage}/></>}</Modal>;
}

function ReviewScreen({ refreshVersion, run, matching, busy, onMatch }: { refreshVersion: number; run: (fn: () => Promise<unknown>, message?: string) => Promise<void>; matching: boolean; busy: boolean; onMatch: () => void }) {
  const [status, setStatus] = useState('review'); const [page, setPage] = useState(1); const [search, setSearch] = useState(''); const [editing, setEditing] = useState<EntityView>(); const [poll, setPoll] = useState(0);
  useEffect(() => { if (!matching) return; const timer = setInterval(() => setPoll(v => v + 1), 2500); return () => clearInterval(timer); }, [matching]);
  const { data, error } = useData<Page<EntityView>>(`/api/library/entities?status=${status}&q=${encodeURIComponent(search)}&page=${page}`, refreshVersion + poll);
  return <><div className="page-heading"><div><h1>Match review.</h1></div><button className="btn secondary" disabled={matching || busy} onClick={onMatch}>{matching ? <Spinner/> : <ScanSearch size={17}/>} {matching ? 'Matching in progress' : 'Find matches'}</button></div><details className="match-help"><summary><Sparkles size={15}/> How matching works</summary><p>The best available recording is selected automatically. You can change a match or skip it anytime before transferring.</p></details><div className="toolbar"><div className="tabs">{[['review', 'Needs review'], ['missing', 'Not found'], ['matched', 'Matched'], ['pending', 'Pending'], ['skipped', 'Skipped']].map(([id, label]) => <button key={id} className={status === id ? 'active' : ''} onClick={() => { setStatus(id); setPage(1); }}>{label}</button>)}</div><label className="search-field"><Search size={17}/><input placeholder="Search source music" aria-label="Search matches" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}/></label></div>{error ? <div className="inline-error">{error}</div> : !data ? <div className="loading"><Spinner/> Loading matches…</div> : data.items.length ? <section className="table-panel"><table className="match-table"><thead><tr><th>Spotify source</th><th/><th>YouTube Music candidate</th><th>Status</th><th/></tr></thead><tbody>{data.items.map(entity => { const candidate = entity.target || entity.candidates[0]; return <tr key={entity.id}><td><div className="track-name"><Cover id={entity.id} name={entity.name} small/><div><strong>{entity.name}</strong><small>{entity.kind} · {entity.artists.join(', ')}</small></div></div></td><td><ArrowRight size={16} className="muted"/></td><td>{candidate ? <><strong>{candidate.name}</strong><small>{candidate.artists.join(', ')}{candidate.album && ` · ${candidate.album}`}</small></> : <span className="muted">{entity.local ? 'Local audio file' : 'No candidate selected'}</span>}</td><td><Badge status={entity.matchStatus}/></td><td><button className="btn compact secondary" onClick={() => setEditing(entity)}>{status === 'matched' ? 'Change' : 'Review'} <ArrowUpRight size={14}/></button></td></tr>; })}</tbody></table><Pager page={page} total={data.total} size={data.pageSize} change={setPage}/></section> : <Empty icon={status === 'review' ? <CheckCircle2 size={32}/> : <ScanSearch size={32}/>} title={status === 'review' ? 'All clear.' : 'Nothing here yet.'}>{status === 'review' ? 'No matches need your review.' : 'Find matches for your selected music.'}</Empty>}{editing && <MatchDialog entity={editing} onClose={() => setEditing(undefined)} run={run}/>}
  </>;
}
function MatchDialog({ entity, onClose, run }: { entity: EntityView; onClose: () => void; run: (fn: () => Promise<unknown>, message?: string) => Promise<void> }) {
  const [query, setQuery] = useState(`${entity.name} ${entity.kind === 'artist' ? '' : entity.artists.join(' ')}`); const [candidates, setCandidates] = useState(entity.candidates); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const act = async (body: unknown) => { setBusy(true); try { await api(`/api/matches/${entity.id}`, { method: 'PATCH', body }); onClose(); await run(async () => {}, 'Match decision saved.'); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } };
  return <Modal title="Choose the right match" onClose={onClose}><div className="source-detail"><Cover id={entity.id} name={entity.name} small/><div><span className="eyebrow">SPOTIFY {entity.kind.toUpperCase()}</span><h3>{entity.name}</h3><p>{entity.artists.join(', ')}{entity.album && ` · ${entity.album}`}</p></div></div><form className="manual-search" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { setCandidates(await api(`/api/matches/${entity.id}/search`, { method: 'POST', body: { query } })); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } }}><input aria-label="Search YouTube Music catalog" minLength={2} maxLength={300} required value={query} onChange={e => setQuery(e.target.value)}/><button className="btn secondary" disabled={busy}>{busy ? <Spinner/> : <Search size={17}/>} Search</button></form>{error && <p className="inline-error">{error}</p>}<div className="candidate-list">{candidates.length ? candidates.map(candidate => <div className="candidate" key={candidate.id}><span className="candidate-icon"><Music2 size={19}/></span><div><strong>{candidate.name}</strong><small>{candidate.artists.join(', ')}{candidate.album && ` · ${candidate.album}`}</small>{candidate.durationMs && <span className="fine-print">{Math.floor(candidate.durationMs / 60000)}:{String(Math.floor(candidate.durationMs % 60000 / 1000)).padStart(2, '0')}</span>}</div><a className="icon-button" aria-label={`Listen to ${candidate.name}`} href={candidate.url} target="_blank" rel="noreferrer"><ExternalLink size={16}/></a><button className="btn compact primary" disabled={busy} onClick={() => void act({ action: 'approve', candidateId: candidate.id })}>Use this</button></div>) : <p className="muted">Search the catalog to find an alternative.</p>}</div><div className="modal-footer"><button className="text-button" disabled={busy} onClick={() => void act({ action: 'reset' })}>Reset to pending</button><button className="btn secondary" disabled={busy} onClick={() => void act({ action: 'skip' })}>Skip this item</button></div></Modal>;
}

function HistoryScreen({ refreshVersion, run, favorites, setFavorites, navigate }: { refreshVersion: number; run: (fn: () => Promise<unknown>, message?: string) => Promise<void>; favorites: Set<string>; setFavorites: (value: Set<string>) => void; navigate: (screen: Screen) => void }) {
  const [page, setPage] = useState(1); const [q, setQ] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [showTaste, setShowTaste] = useState(false);
  const { data, error } = useData<Page<{ id: string; entity: EntityView; playedAt: string; msPlayed: number; skipped: boolean; source: string }> & { milliseconds: number }>(`/api/history?page=${page}&q=${encodeURIComponent(q)}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`, refreshVersion);
  const top = useData<(EntityView & { milliseconds: number; plays: number })[]>('/api/history/favorites', refreshVersion);
  return <><div className="page-heading"><div><h1>Listening history.</h1></div><a className="btn secondary" href="/api/export?type=history&format=csv"><Download size={17}/> Export history</a></div><div className="history-feature"><div className="history-feature-icon"><Sparkles size={28}/></div><div><h2>Your most played.</h2><p>Turn your listening history into a playlist.</p></div><div><button className="btn secondary" disabled={!top.data?.length} onClick={() => void run(async () => { await api('/api/history/playlist', { method: 'POST' }); navigate('library'); }, 'Most Played on Spotify added to your source collection. Match it before transferring.')}><Plus size={17}/> Create playlist</button><button className="btn primary" disabled={!top.data?.length} onClick={() => setShowTaste(true)}><Heart size={17}/> Review favorites</button></div></div><div className="toolbar history-toolbar"><label className="search-field"><Search size={17}/><input placeholder="Search listening history" aria-label="Search listening history" value={q} onChange={e => { setQ(e.target.value); setPage(1); }}/></label><div className="date-filters"><label>From<input type="date" value={from} onChange={e => { setFrom(e.target.value); setPage(1); }}/></label><label>To<input type="date" value={to} onChange={e => { setTo(e.target.value); setPage(1); }}/></label><span className="fine-print">Filters use UTC dates</span></div></div>{error ? <p className="inline-error">{error}</p> : !data ? <div className="loading"><Spinner/> Loading history…</div> : data.items.length ? <section className="table-panel"><div className="history-summary"><strong>{number(data.total)} listening events</strong><span>{duration(data.milliseconds)} of recorded listening time</span></div><table><thead><tr><th>Track</th><th>Artist</th><th>Listened</th><th>Played at</th><th/></tr></thead><tbody>{data.items.map(event => <tr key={event.id}><td><strong>{event.entity.name}</strong><small>{event.entity.album}</small></td><td>{event.entity.artists.join(', ')}</td><td>{event.msPlayed ? duration(event.msPlayed) : 'Unknown'}</td><td>{date(event.playedAt)}<small>{new Date(event.playedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></td><td>{event.skipped && <Badge status="skipped"/>}</td></tr>)}</tbody></table><Pager page={page} total={data.total} size={data.pageSize} change={setPage}/></section> : <Empty icon={<Headphones size={32}/>} title="No listens yet.">Import a Spotify streaming-history file.</Empty>}{showTaste && <Modal title="Choose additional favorites" onClose={() => setShowTaste(false)}><p className="muted">These songs earned the most listening time. Only the favorites you select will receive additional likes. Recommendation changes depend on YouTube Music.</p><div className="taste-list">{top.data?.map(entity => <label key={entity.id} className="taste-row"><input type="checkbox" disabled={entity.liked} checked={entity.liked || favorites.has(entity.id)} onChange={e => { const next = new Set(favorites); if (e.target.checked) next.add(entity.id); else next.delete(entity.id); setFavorites(next); }}/><div><strong>{entity.name}</strong><small>{entity.artists.join(', ')}</small></div><span>{entity.liked ? 'Already a Spotify like' : `${duration(entity.milliseconds)} · ${number(entity.plays)} plays`}</span></label>)}</div><div className="modal-footer"><span>{favorites.size} additional likes selected</span><button className="btn primary" onClick={() => { setShowTaste(false); navigate('review'); }}>Save selection <ArrowRight size={16}/></button></div></Modal>}</>;
}

function TransfersScreen({ refreshVersion, run, busy }: { refreshVersion: number; run: (fn: () => Promise<unknown>, message?: string) => Promise<void>; busy: boolean }) {
  const [page, setPage] = useState(1); const [poll, setPoll] = useState(0); const { data, error } = useData<Page<Job>>(`/api/jobs?page=${page}`, refreshVersion + poll);
  useEffect(() => { const timer = setInterval(() => setPoll(v => v + 1), 2000); return () => clearInterval(timer); }, []);
  const action = (job: Job, value: string) => void run(() => api(`/api/jobs/${job.id}/${value}`, { method: 'POST' }));
  return <><div className="page-heading"><div><h1>Transfers.</h1></div></div>{error ? <p className="inline-error">{error}</p> : !data ? <div className="loading"><Spinner/> Loading transfers…</div> : !data.items.length ? <Empty icon={<ArrowRightLeft size={32}/>} title="No transfers yet.">Choose your music to make the first move.</Empty> : <>
    <div className="job-list">{data.items.map(job => {
      const processed = job.done + job.skipped + job.failed;
      const percent = job.total ? Math.min(100, processed / job.total * 100) : 0;
      const canResolveFailures = job.failed > 0 && !active(job) && !['completed', 'cancelled'].includes(job.status);
      return <article className="job-card" key={job.id}>
        <div className="job-heading"><span className={`job-icon ${job.kind}`}>{job.kind === 'match' ? <ScanSearch size={23}/> : job.kind === 'spotify_import' ? <Download size={23}/> : <ArrowRightLeft size={23}/>}</span><div><h3>{job.kind === 'match' ? 'Catalog matching' : job.kind === 'spotify_import' ? 'Spotify library import' : 'YouTube Music transfer'}</h3><span>Started {date(job.createdAt)} · {new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><Badge status={job.status}/></div>
        <p className="job-message">{job.message}</p>
        <div className={`progress-track ${active(job) && !job.total ? 'indeterminate' : ''}`}><span style={{ width: `${percent}%` }}/></div>
        <TransferCounts job={job}/>
        <div className="job-footer"><a className="text-button" href={`/api/jobs/${job.id}/report?format=csv`}><Download size={15}/> Download CSV report</a><a className="text-button" href={`/api/jobs/${job.id}/report?format=json`}>JSON</a><div>
          {active(job) && <button className="btn compact secondary" disabled={busy} onClick={() => action(job, 'pause')}><Pause size={15}/> Pause</button>}
          {['paused', 'needs_review', 'failed'].includes(job.status) && <button className="btn compact primary" disabled={busy} onClick={() => action(job, 'resume')}><Play size={15}/> Resume</button>}
          {canResolveFailures && <button className="btn compact secondary" disabled={busy} onClick={() => action(job, 'retry')}><RefreshCw size={15}/> Retry failed</button>}
          {canResolveFailures && job.kind === 'transfer' && <button className="btn compact secondary" disabled={busy} title="Skip failed actions and the remaining tracks in affected playlists, then continue. Completed actions and other playlists are kept." onClick={() => action(job, 'skip-failed')}><ArrowRight size={15}/> Skip failed & continue</button>}
          {!['completed', 'completed_with_issues', 'cancelled'].includes(job.status) && <button className="btn compact ghost" disabled={busy} onClick={() => action(job, 'cancel')}>Cancel</button>}
        </div></div>
      </article>;
    })}</div>
    <Pager page={page} total={data.total} size={data.pageSize} change={setPage}/>
  </>}</>;
}
