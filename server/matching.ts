import type { Candidate, SourceEntity, MatchStatus } from '../shared/types.js';

export const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const versions = (name: string) => (normalize(name).match(/\b(live|remix|cover|instrumental|acoustic|karaoke|sped up|slowed|clean|remaster(?:ed)?)\b/g) || []).sort().join('|');
const similarity = (a: string, b: string) => {
  const first = new Set(normalize(a).split(' ')); const second = new Set(normalize(b).split(' '));
  return [...first].filter(x => second.has(x)).length / Math.max(first.size, second.size, 1);
};
export function chooseMatch(source: SourceEntity, candidates: Candidate[]): { status: MatchStatus; target?: Candidate; candidates: Candidate[]; reason: string } {
  if (source.local) return { status: 'skipped', candidates: [], reason: 'Local audio files cannot be transferred as catalog references.' };
  const scored = candidates.filter(c => c.available !== false).map(candidate => {
    const title = similarity(source.name, candidate.name);
    const artist = source.kind === 'artist' ? title : Math.max(0, ...source.artists.flatMap(a => candidate.artists.map(b => similarity(a, b))));
    const album = source.album && candidate.album ? similarity(source.album, candidate.album) : 0;
    return { ...candidate, score: Math.round((title * 0.55 + artist * 0.35 + album * 0.1) * 100) };
  }).sort((a, b) => b.score - a.score);
  const exact = scored.filter(c => normalize(source.name) === normalize(c.name) && versions(source.name) === versions(c.name)
    && (source.kind === 'artist' || source.artists.some(a => c.artists.some(b => normalize(a) === normalize(b))))
    && (source.explicit === undefined || c.explicit === undefined || source.explicit === c.explicit)
    && (source.durationMs === undefined || c.durationMs === undefined || Math.abs(source.durationMs - c.durationMs) <= Math.max(5000, source.durationMs * 0.03)));
  const albumExact = source.album ? exact.filter(c => c.album && normalize(c.album) === normalize(source.album!)) : [];
  const strong = albumExact.length ? albumExact : exact;
  if (strong.length === 1) return { status: 'matched', target: strong[0], candidates: scored, reason: 'Unambiguous title, artist, and version match.' };
  return { status: scored.length ? 'review' : 'missing', candidates: scored, reason: scored.length ? 'Choose the correct recording or skip this item.' : 'No available catalog match found.' };
}
