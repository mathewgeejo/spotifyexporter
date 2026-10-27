import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, CircleAlert, Disc3, Heart, ListMusic, Music2, Plus, Upload, UsersRound } from 'lucide-react';
import type { Collection, ConnectionStatus } from '../../shared/types.js';
import type { Overview, Screen } from '../types.js';
import ServiceIcon from './ServiceIcon.js';
import { Cover, Spinner } from './ui.js';

type Props = {
  overview: Overview; connections: ConnectionStatus; collections: Collection[]; busy: boolean;
  onImport: () => void; onDrop: (files: FileList) => Promise<void>; navigate: (screen: Screen) => void; onSync: () => void;
};
const number = (value = 0) => new Intl.NumberFormat().format(value);
const compact = (value = 0) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export default function OverviewScreen({ overview, connections, collections, busy, onImport, onDrop, navigate, onSync }: Props) {
  const [dragging, setDragging] = useState(false);
  const hasData = !!(overview.counts.playlists || overview.counts.songs || overview.counts.albums || overview.counts.artists);
  const stats = [
    { name: 'Playlists', value: overview.counts.playlists, icon: <ListMusic size={19}/> },
    { name: 'Liked songs', value: overview.counts.likes, icon: <Heart size={19}/> },
    { name: 'Albums', value: overview.counts.albums, icon: <Disc3 size={19}/> },
    { name: 'Artists', value: overview.counts.artists, icon: <UsersRound size={19}/> },
  ];
  const start = () => connections.spotify.connected ? hasData ? navigate('library') : onSync() : navigate('settings');

  return <div className="overview-v2">
    <div className="page-heading compact-heading"><h1>Make your move.</h1><span className="quiet-pill"><span/> Free accounts welcome</span></div>

    <section className="move-stage" aria-label="Spotify to YouTube Music transfer">
      <div className="stage-copy">
        <span className="stage-kicker"><span/> YOUR MUSIC, COMING WITH YOU</span>
        <h2>Same music.<br/><em>New home.</em></h2>
        <div className="stage-cta"><button className="btn primary" disabled={busy} onClick={start}>{busy ? <Spinner/> : null}{hasData ? 'Choose your music' : connections.spotify.connected ? 'Import library' : 'Get started'}<ArrowUpRight size={18}/></button><span>Spotify <ArrowRight size={12}/> YouTube Music</span></div>
      </div>

      <div className="stage-art" aria-hidden="true">
        <div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/>
        <div className="stage-vinyl"><div className="vinyl-center"><ServiceIcon service="youtube" size={30}/><i/></div></div>
        <div className="stage-sleeve"><div className="sleeve-grid"/><div className="sleeve-symbol"><span/><span/><span/><span/></div><div className="sleeve-footer"><Music2 size={20}/><div className="waveform">{[8, 15, 23, 13, 29, 19, 10, 24, 15, 8].map((height, index) => <i key={index} style={{ height }}/>)}</div></div></div>
        <span className="art-token token-spotify"><ServiceIcon service="spotify" size={30}/></span>
        <span className="art-token token-heart"><Heart size={21}/></span>
      </div>

      <div className="service-route">
        <button className="route-account" onClick={() => navigate('settings')}><span className="service-icon spotify"><ServiceIcon service="spotify"/></span><span><strong>Spotify</strong><small>{connections.spotify.connected ? connections.spotify.account : 'Connect source'}</small></span><span className={`route-status ${connections.spotify.connected ? 'ready' : ''}`}>{connections.spotify.connected ? <Check size={14}/> : <Plus size={14}/>}</span></button>
        <span className="route-arrow" aria-hidden="true"><span/><ArrowRight size={18}/><span/></span>
        <button className="route-account" onClick={() => navigate('settings')}><span className="service-icon youtube"><ServiceIcon service="youtube"/></span><span><strong>YouTube Music</strong><small>{connections.youtube.connected ? connections.youtube.account : 'Connect destination'}</small></span><span className={`route-status ${connections.youtube.connected ? 'ready' : ''}`}>{connections.youtube.connected ? <Check size={14}/> : <Plus size={14}/>}</span></button>
      </div>
    </section>

    <div className="collection-metrics">{stats.map(stat => <button key={stat.name} title={`${number(stat.value)} ${stat.name}`} onClick={() => navigate('library')}><span className="metric-icon">{stat.icon}</span><span className="metric-number">{compact(stat.value)}</span><span className="metric-name">{stat.name}</span><ArrowUpRight size={14} className="metric-arrow"/></button>)}</div>

    <section className="playlist-shelf">
      <div className="section-heading"><h2>Your playlists <span>{number(collections.length)}</span></h2><button className="text-button" onClick={() => navigate('library')}>View all <ArrowUpRight size={15}/></button></div>
      {collections.length ? <div className="shelf-grid">{collections.slice(0, 4).map(collection => <button className="shelf-playlist" key={collection.id} onClick={() => navigate('library')}><Cover id={collection.id} name={collection.name}/><strong>{collection.name}</strong><small>{number(collection.count)} tracks</small></button>)}</div> : <div className="shelf-empty"><div className="empty-sleeves" aria-hidden="true"><span><Disc3 size={35}/></span><span><Music2 size={34}/></span><span><Heart size={30}/></span></div><div><h3>A little quiet here.</h3><p>Your playlists will land here.</p></div><button className="btn secondary" disabled={busy} onClick={start}>{connections.spotify.connected ? 'Import music' : 'Add your music'}<Plus size={16}/></button></div>}
    </section>

    <div className={`archive-strip ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); if (!busy) void onDrop(event.dataTransfer.files); }}><span className="archive-icon"><Upload size={19}/></span><div><strong>Have a Spotify export?</strong><span>Drop a ZIP or JSON file</span></div><button className="text-button" disabled={busy} onClick={onImport}>{busy ? <Spinner/> : <>Browse files <ArrowUpRight size={15}/></>}</button></div>

    {overview.imports.some(item => item.stats.warnings.length) && <details className="import-warnings"><summary><CircleAlert size={16}/> Import notes</summary>{overview.imports.slice(0, 5).flatMap(item => item.stats.warnings.map((warning, index) => <p key={`${item.id}-${index}`}>{warning}</p>))}</details>}
  </div>;
}
