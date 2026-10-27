import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseMatch } from '../server/matching.js';
import type { SourceEntity, Candidate } from '../shared/types.js';

const source: SourceEntity = { id: 'source', kind: 'song', name: 'Song', artists: ['Artist'], album: 'Album', durationMs: 180000 };
const candidate: Candidate = { id: 'one', name: 'Song', artists: ['Artist'], album: 'Album', durationMs: 180000, url: 'https://music.youtube.com/watch?v=one' };
test('best available recordings are selected automatically without review', () => {
  assert.equal(chooseMatch(source, [candidate]).status, 'matched');
  assert.equal(chooseMatch(source, [candidate, { ...candidate, id: 'two' }]).status, 'matched');
  for (const name of ['Song (Live)', 'Song (Cover)', 'Song (Remix)', 'Song (Acoustic)', 'Song (Sped Up)']) assert.equal(chooseMatch(source, [{ ...candidate, name }]).status, 'matched');
  assert.equal(chooseMatch(source, [{ ...candidate, artists: ['Other artist'] }]).status, 'matched');
  assert.equal(chooseMatch(source, [{ ...candidate, durationMs: 230000 }]).status, 'matched');
  assert.equal(chooseMatch(source, [{ ...candidate, available: false }]).status, 'skipped');
  assert.equal(chooseMatch({ ...source, local: true }, [candidate]).status, 'skipped');
});
test('albums and artists are also selected automatically; missing duration does not invent one', () => {
  assert.equal(chooseMatch({ ...source, kind: 'album', name: 'Album', durationMs: undefined }, [{ ...candidate, name: 'Album' }]).status, 'matched');
  assert.equal(chooseMatch({ ...source, kind: 'artist', name: 'Artist', durationMs: undefined }, [{ ...candidate, name: 'Artist' }]).status, 'matched');
  assert.equal(chooseMatch({ ...source, durationMs: undefined }, [{ ...candidate, durationMs: undefined }]).status, 'matched');
  assert.equal(chooseMatch({ ...source, explicit: true }, [{ ...candidate, explicit: false }]).status, 'matched');
});
