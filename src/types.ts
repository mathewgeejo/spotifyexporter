import type { Job } from '../shared/types.js';

export type Screen = 'overview' | 'library' | 'review' | 'history' | 'transfers' | 'settings';
export type RunAction = (action: () => Promise<unknown>, message?: string) => Promise<void>;
export type Overview = {
  counts: Record<string, number>;
  imports: { id: string; name: string; created: string; stats: { warnings: string[]; playlists: number; songs: number; history: number } }[];
  jobs: Job[];
};
