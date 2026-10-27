export type EntityKind = 'song' | 'album' | 'artist';
export type MatchStatus = 'pending' | 'matched' | 'review' | 'skipped' | 'missing';
export interface SourceEntity {
  id: string;
  kind: EntityKind;
  name: string;
  artists: string[];
  album?: string;
  uri?: string;
  durationMs?: number;
  explicit?: boolean;
  local?: boolean;
  liked?: boolean;
  saved?: boolean;
  followed?: boolean;
}
export interface Candidate {
  id: string;
  name: string;
  artists: string[];
  album?: string;
  durationMs?: number;
  explicit?: boolean;
  available?: boolean;
  score?: number;
  url: string;
}
export interface EntityView extends SourceEntity {
  matchStatus: MatchStatus;
  target?: Candidate;
  candidates: Candidate[];
  reason?: string;
}
export interface Collection {
  id: string;
  name: string;
  description: string;
  sourceUri?: string;
  count: number;
  inaccessible?: boolean;
  generated?: boolean;
}
export interface ListeningEvent {
  id: string;
  entityId: string;
  playedAt: string;
  msPlayed: number;
  skipped: boolean;
  source: string;
}
export type JobStatus = 'queued' | 'running' | 'paused' | 'needs_review' | 'completed' | 'completed_with_issues' | 'failed' | 'cancelled';
export interface Job {
  id: string;
  kind: 'match' | 'transfer' | 'spotify_import';
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  message: string;
  createdAt: string;
  updatedAt: string;
}
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
export interface ConnectionStatus {
  youtube: { connected: boolean; account?: string; channelId?: string };
  spotify: { configured: boolean; connected: boolean; account?: string; mode?: 'web' | 'oauth' };
}
export interface TransferSelection {
  collectionIds: string[];
  likes: boolean;
  songs: boolean;
  albums: boolean;
  artists: boolean;
  favoriteIds: string[];
}
