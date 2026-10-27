import { ChevronDown } from 'lucide-react';
import type { Job } from '../../shared/types.js';

const number = (value: number) => new Intl.NumberFormat().format(value);

export default function TransferCounts({ job }: { job: Job }) {
  const summary = job.summary;
  const processed = job.done + job.skipped + job.failed;
  const breakdown = summary ? [
    ['Playlists created', summary.playlists], ['Playlist entries', summary.playlistEntries], ['Likes', summary.likes],
    ['Songs saved', summary.savedSongs], ['Albums', summary.albums], ['Artists', summary.artists],
  ] as const : [];
  return <>
    {summary && <div className="job-plan"><span><strong>{number(summary.sourceItems)}</strong> source items</span><details><summary>{number(job.total)} actions <ChevronDown size={12}/></summary><div className="action-breakdown"><p>A song can appear in several playlists and also be liked or saved.</p>{breakdown.filter(([, count]) => count > 0).map(([label, count]) => <span key={label}><span>{label}</span><strong>{number(count)}</strong></span>)}</div></details></div>}
    <div className="job-counts"><span><i className="dot green"/>{number(job.done)} {summary ? 'actions done' : 'completed'}</span><span><i className="dot amber"/>{number(job.skipped)} skipped</span><span><i className="dot red"/>{number(job.failed)} failed</span><span>{number(Math.max(0, job.total - processed))} {summary ? 'actions pending' : 'pending'}</span></div>
  </>;
}
