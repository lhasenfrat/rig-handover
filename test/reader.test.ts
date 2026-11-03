import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';

// Real nights, read-only: never write here.
const runsDir = fileURLToPath(new URL('../runs', import.meta.url));

describe('readNight on runs/2026-10-28.jsonl', () => {
  const digest = readNight(runsDir, '2026-10-28');
  const row = (job: string) => digest?.rows.find((r) => r.job === job);

  it('has 5 jobs sorted by name and 1 bad line', () => {
    expect(digest?.night).toBe('2026-10-28');
    expect(digest?.rows.map((r) => r.job)).toEqual([
      'digest/render',
      'fixtures/refresh',
      'lane/sync',
      'notes/backup',
      'rig/rotate-logs',
    ]);
    expect(digest?.badLines).toBe(1);
  });

  it('counts valid lines by status', () => {
    expect(digest?.counts).toEqual({ ok: 10, retry: 4, fail: 1 });
  });

  it('fixtures/refresh: 3 retries, then ok', () => {
    expect(row('fixtures/refresh')).toEqual({
      job: 'fixtures/refresh',
      owner: 'rook',
      runs: 4,
      retries: 3,
      lastStatus: 'ok',
      lastError: null,
      firstAt: '2026-10-29T01:30:00+01:00',
      lastAt: '2026-10-29T01:37:00+01:00',
    });
  });

  it('notes/backup: last status fail with its error', () => {
    expect(row('notes/backup')).toMatchObject({ lastStatus: 'fail', lastError: 'quota exceeded', owner: 'lane-07' });
  });

  it('digest/render: owner null, row kept', () => {
    expect(row('digest/render')).toMatchObject({ owner: null, runs: 1, lastStatus: 'ok' });
  });

  it('lane/sync: times keep the offset from the log', () => {
    expect(row('lane/sync')).toMatchObject({
      runs: 8,
      retries: 1,
      firstAt: '2026-10-28T23:00:06+01:00',
      lastAt: '2026-10-29T05:00:04+01:00',
    });
  });
});

describe('readNight edge cases (temp dir)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rig-reader-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (night: string, lines: string[]) => writeFileSync(join(dir, `${night}.jsonl`), lines.join('\n'));

  it('no file for the night: null', () => {
    expect(readNight(dir, '2026-01-01')).toBeNull();
  });

  it('a night that is not YYYY-MM-DD: null', () => {
    expect(readNight(dir, '../2026-01-01')).toBeNull();
  });

  it('empty file: a digest with no rows', () => {
    write('2026-01-02', []);
    expect(readNight(dir, '2026-01-02')).toEqual({
      night: '2026-01-02',
      rows: [],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 0 },
    });
  });

  it('bad lines are counted, blank lines are not, nothing throws', () => {
    write('2026-01-03', [
      '{"at":"2026-01-03T01:00:00+01:00","job":"a","status":"ok","owner":"rook"}',
      '',
      'not json',
      '[]',
      '{"at":"2026-01-03T02:00:00+01:00","job":"a","status":"done","owner":"rook"}',
      '{"at":"2026-01-03T02:00:00+01:00","job":"a","status":"ok"}',
      '{"at":"yesterday","job":"a","status":"ok","owner":"rook"}',
      '{"at":"2026-01-03T03:00:00+01:00","job":"a","status":"fail","owner":"rook","error":42}',
      '',
    ]);
    const digest = readNight(dir, '2026-01-03');
    expect(digest?.badLines).toBe(6);
    expect(digest?.counts).toEqual({ ok: 1, retry: 0, fail: 0 });
    expect(digest?.rows).toHaveLength(1);
  });

  it('last status follows time, not file order; offsets kept as written', () => {
    write('2026-01-04', [
      '{"at":"2026-01-04T01:00:00+02:00","job":"b","status":"fail","owner":"rook","error":"boom"}',
      '{"at":"2026-01-04T00:30:00+01:00","job":"b","status":"ok","owner":"rook"}',
      '{"at":"2026-01-03T23:45:00Z","job":"b","status":"retry","owner":"rook","error":"busy"}',
    ]);
    // Instants: 23:00Z (fail), 23:30Z (ok), 23:45Z (retry).
    expect(readNight(dir, '2026-01-04')?.rows[0]).toEqual({
      job: 'b',
      owner: 'rook',
      runs: 3,
      retries: 1,
      lastStatus: 'retry',
      lastError: 'busy',
      firstAt: '2026-01-04T01:00:00+02:00',
      lastAt: '2026-01-03T23:45:00Z',
    });
  });
});
