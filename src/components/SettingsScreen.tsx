import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronDown, Download, ExternalLink, LockKeyhole, Plus, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import type { ConnectionStatus } from '../../shared/types.js';
import { api } from '../api.js';
import type { RunAction, Screen } from '../types.js';
import ServiceIcon from './ServiceIcon.js';
import { Modal, Spinner } from './ui.js';

type Props = { connections: ConnectionStatus; run: RunAction; busy: boolean; onImport: () => void; navigate: (screen: Screen) => void };

export default function SettingsScreen({ connections, run, busy, onImport, navigate }: Props) {
  const [connecting, setConnecting] = useState<'spotify' | 'youtube'>();
  const [spotifySession, setSpotifySession] = useState('');
  const [cookie, setCookie] = useState('');
  const [accountIndex, setAccountIndex] = useState(0);
  const [channelId, setChannelId] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const closeConnection = () => { setConnecting(undefined); setSpotifySession(''); setCookie(''); };
  const sync = () => void run(async () => { await api('/api/imports/spotify', { method: 'POST' }); navigate('transfers'); }, 'Import queued.');

  return <div className="connections-v2">
    <div className="page-heading compact-heading"><h1>Your accounts.</h1><span className="quiet-pill"><LockKeyhole size={12}/> Stored privately</span></div>
    <div className="account-cards">
      {(['spotify', 'youtube'] as const).map(service => {
        const connection = connections[service];
        const needsReconnect = service === 'youtube' && !!connections.youtube.needsReconnect;
        const name = service === 'spotify' ? 'Spotify' : 'YouTube Music';
        return <section className={`connect-card ${service}`} key={service}>
          <div className="connect-card-top"><span className="eyebrow">{service === 'spotify' ? '01 / SOURCE' : '02 / DESTINATION'}</span><span className={`connection-state ${needsReconnect ? 'expired' : connection.connected ? 'ready' : ''}`}><span/>{needsReconnect ? 'Reconnect needed' : connection.connected ? 'Connected' : 'Not connected'}</span></div>
          <div className="connect-brand"><span><ServiceIcon service={service} size={66}/></span><div><h2>{name}</h2><p>{connection.connected ? connection.account : service === 'spotify' ? 'Bring your collection.' : 'Give it a new home.'}</p></div></div>
          <div className="connect-card-bottom">
            <span className="connection-caption">{service === 'spotify' ? 'Playlists & liked songs' : 'Private playlists & likes'}</span>
            <button className={`btn ${connection.connected && !needsReconnect ? 'secondary' : 'primary'}`} disabled={busy} onClick={() => connection.connected && service === 'spotify' ? sync() : setConnecting(service)}>{connection.connected ? service === 'spotify' ? <><RefreshCw size={15}/> Refresh library</> : <><RefreshCw size={15}/> Reconnect</> : <>Connect {service === 'spotify' ? 'Spotify' : 'YouTube Music'}<ArrowUpRight size={16}/></>}</button>
          </div>
          {connection.connected && <div className="account-management"><button className="text-button" disabled={busy} onClick={() => setConnecting(service)}>Replace session</button><button className="text-button danger-text" disabled={busy} onClick={() => void run(() => api(`/api/connections/${service}`, { method: 'DELETE' }), `${name} disconnected.`)}>Disconnect</button></div>}
        </section>;
      })}
    </div>

    <section className="account-tools">
      <div className="tool-row"><span className="tool-icon"><Upload size={20}/></span><div><h2>Import a file</h2><span>Spotify ZIP or JSON</span></div><button className="btn secondary" disabled={busy} onClick={onImport}>Upload <Plus size={15}/></button></div>
      <div className="tool-row"><span className="tool-icon"><Download size={20}/></span><div><h2>Your data</h2><span>Take a copy anytime</span></div><details className="download-menu"><summary className="btn secondary">Export <ChevronDown size={15}/></summary><div><a href="/api/export?type=library&format=json">Library · JSON</a><a href="/api/export?type=library&format=csv">Library · CSV</a><a href="/api/export?type=history&format=json">History · JSON</a><a href="/api/export?type=history&format=csv">History · CSV</a></div></details></div>
    </section>
    <details className="more-settings"><summary>More options <ChevronDown size={14}/></summary><div><a className="text-button" href="/api/docs" target="_blank" rel="noreferrer">API reference <ExternalLink size={13}/></a>{connections.spotify.configured && <button className="text-button" disabled={busy} onClick={() => void run(async () => { const response = await api('/api/connections/spotify/authorize', { method: 'POST' }); location.assign(response.url); })}>Spotify developer app <ArrowRight size={14}/></button>}<button className="text-button danger-text" disabled={busy} onClick={() => setDeleting(true)}>Delete imported data</button></div></details>

    {connecting && <Modal title={`Connect ${connecting === 'spotify' ? 'Spotify' : 'YouTube Music'}`} onClose={closeConnection}>
      <div className={`connection-dialog-brand ${connecting}`}><ServiceIcon service={connecting} size={32}/><span>{connecting === 'spotify' ? 'Free and Premium accounts' : 'Your destination account'}</span></div>
      <details className="setup-guide connection-guide"><summary>Where do I find my session cookie?</summary>{connecting === 'spotify' ? <ol><li>Open <a href="https://open.spotify.com" target="_blank" rel="noreferrer">Spotify</a> and sign in.</li><li>Press <strong>F12</strong> → <strong>Application → Cookies → open.spotify.com</strong>. Firefox: <strong>Storage → Cookies</strong>.</li><li>Copy the <strong>Value</strong> of <code>sp_dc</code>.</li></ol> : <ol><li>Open <a href="https://music.youtube.com" target="_blank" rel="noreferrer">YouTube Music</a> and select your account.</li><li>Press <strong>F12</strong> → <strong>Network</strong>, then click Library.</li><li>Open a <code>/browse</code> request. Copy <strong>Cookie</strong> from its Request Headers.</li></ol>}</details>
      <form onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          if (connecting === 'spotify') {
            await api('/api/connections/spotify', { method: 'POST', body: { cookie: spotifySession } });
            await api('/api/imports/spotify', { method: 'POST' }); closeConnection(); navigate('transfers');
          } else {
            await api('/api/connections/youtube', { method: 'POST', body: { cookie, accountIndex, ...(channelId ? { channelId } : {}) } }); closeConnection();
          }
        }, connecting === 'spotify' ? 'Connected. Importing your music.' : 'YouTube Music connected.');
      }}>
        {connecting === 'spotify' ? <label>Spotify session cookie<textarea rows={3} value={spotifySession} onChange={event => setSpotifySession(event.target.value)} minLength={20} maxLength={32000} required autoComplete="off" spellCheck={false} placeholder="Paste the sp_dc value"/></label> : <><label>YouTube session cookie<textarea rows={3} value={cookie} onChange={event => setCookie(event.target.value)} minLength={20} maxLength={32000} required autoComplete="off" spellCheck={false} placeholder="Paste the Cookie request-header value"/></label><details className="advanced"><summary>Multiple accounts or a brand channel</summary><div className="form-row"><label>Google account index<input type="number" min={0} max={20} value={accountIndex} onChange={event => setAccountIndex(Number(event.target.value))}/></label><label>Brand channel ID (optional)<input value={channelId} onChange={event => setChannelId(event.target.value)} placeholder="Channel or brand account ID"/></label></div><p className="fine-print">The account index is the x-goog-authuser header value.</p></details></>}
        <div className="connection-dialog-footer"><span><ShieldCheck size={14}/> Encrypted on this device</span><button className="btn primary" disabled={busy || !(connecting === 'spotify' ? spotifySession : cookie).trim()}>{busy ? <Spinner/> : <Check size={16}/>} {connecting === 'spotify' ? 'Connect & import library' : 'Connect account'}</button></div>
      </form>
    </Modal>}
    {deleting && <Modal title="Delete imported data" onClose={() => setDeleting(false)}><p>Removes local imports, history, reports, and transfer mappings. Music already transferred stays in YouTube Music. Reimporting afterward can create duplicate destination playlists.</p><label>Type DELETE MY IMPORTED DATA<input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="off"/></label><div className="modal-footer"><button className="btn secondary" onClick={() => setDeleting(false)}>Keep my data</button><button className="btn danger" disabled={confirmation !== 'DELETE MY IMPORTED DATA' || busy} onClick={() => void run(async () => { await api('/api/data', { method: 'DELETE', body: { confirmation } }); setDeleting(false); }, 'Imported data deleted.')}>Delete permanently</button></div></Modal>}
  </div>;
}
