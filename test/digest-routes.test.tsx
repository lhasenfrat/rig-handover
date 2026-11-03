import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

// Fixtures live in a temp dir: runs/ is read-only.
const NIGHT_OK = '2026-10-30'; // two jobs, one retry, one fail, one owner null
const NIGHT_BAD = '2026-10-29'; // one bad line
const NIGHT_EMPTY = '2026-10-31'; // empty file
const NIGHT_MISSING = '2026-10-01'; // no file

const JOB_ORDER = ['backup-db', 'export-csv', 'mail-digest'];

let runsDir: string;

const line = (at: string, job: string, status: string, owner: string | null, error?: string) =>
  JSON.stringify({ at, job, status, owner, ...(error ? { error } : {}) });

beforeAll(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
  // Jobs are written out of order on purpose: the digest must sort them by job.
  writeFileSync(
    join(runsDir, `${NIGHT_OK}.jsonl`),
    [
      line('2026-10-30T01:00:00+01:00', 'mail-digest', 'ok', 'ana'),
      line('2026-10-30T02:00:00+01:00', 'backup-db', 'retry', 'bo', 'timeout'),
      line('2026-10-30T02:10:00+01:00', 'backup-db', 'ok', 'bo'),
      line('2026-10-30T03:00:00+01:00', 'export-csv', 'fail', null, 'disk full'),
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(runsDir, `${NIGHT_BAD}.jsonl`),
    [
      line('2026-10-29T01:00:00+01:00', 'mail-digest', 'ok', 'ana'),
      '{ this line does not parse',
      line('2026-10-29T03:00:00+01:00', 'export-csv', 'fail', 'cy', 'disk full'),
      '',
    ].join('\n'),
  );
  writeFileSync(join(runsDir, `${NIGHT_EMPTY}.jsonl`), '');
});

afterAll(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

const config = () => ({
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir,
});

// hono/jsx escapes apostrophes in dynamic text; decode them so text assertions read naturally.
const textOf = (html: string) => html.replace(/&#39;|&#x27;|&apos;/g, "'");

describe('digest page GET /digest/:night', () => {
  it('200 for a night with a file, with a row per job', async () => {
    const res = await createApp(config()).request(`/digest/${NIGHT_OK}`);
    const html = textOf(await res.text());
    expect(res.status).toBe(200);
    for (const job of JOB_ORDER) expect(html).toContain(job);
  });

  it('404 for a night with no file', async () => {
    const res = await createApp(config()).request(`/digest/${NIGHT_MISSING}`);
    expect(res.status).toBe(404);
  });

  it('404 for a night that is not a date', async () => {
    const res = await createApp(config()).request('/digest/latest');
    expect(res.status).toBe(404);
  });

  it('200 for the empty night and says "nothing ran"', async () => {
    const res = await createApp(config()).request(`/digest/${NIGHT_EMPTY}`);
    const html = textOf(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain('nothing ran');
  });

  it('200 for a night with a bad line and counts it', async () => {
    const res = await createApp(config()).request(`/digest/${NIGHT_BAD}`);
    const html = textOf(await res.text());
    expect(res.status).toBe(200);
    expect(html).toContain("1 line didn't parse");
    expect(html).toContain('mail-digest');
    expect(html).toContain('export-csv');
  });
});

describe('digest JSON GET /api/digest/:night', () => {
  it('200 with night, rows, badLines and counts', async () => {
    const res = await createApp(config()).request(`/api/digest/${NIGHT_OK}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      night: string;
      rows: Record<string, unknown>[];
      badLines: number;
      counts: { ok: number; retry: number; fail: number };
    };
    expect(body.night).toBe(NIGHT_OK);
    expect(body.badLines).toBe(0);
    expect(body.counts).toEqual({ ok: 2, retry: 1, fail: 1 });
    expect(body.rows.map((r) => r.job)).toEqual(JOB_ORDER);
    for (const row of body.rows) {
      expect(row).toEqual(
        expect.objectContaining({
          job: expect.any(String),
          runs: expect.any(Number),
          retries: expect.any(Number),
          lastStatus: expect.stringMatching(/^(ok|retry|fail)$/),
          firstAt: expect.any(String),
          lastAt: expect.any(String),
        }),
      );
      // owner and lastError may be null: the key must exist, the value may not.
      expect(row).toHaveProperty('owner');
      expect(row).toHaveProperty('lastError');
    }
    const exportRow = body.rows.find((r) => r.job === 'export-csv');
    expect(exportRow?.owner).toBeNull();
    expect(exportRow?.lastStatus).toBe('fail');
  });

  it('404 with an error for a night with no file', async () => {
    const res = await createApp(config()).request(`/api/digest/${NIGHT_MISSING}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: unknown };
    expect(body.error).toBeDefined();
  });

  it('404 for a night that is not a date', async () => {
    const res = await createApp(config()).request('/api/digest/latest');
    expect(res.status).toBe(404);
  });

  it('200 for the empty night with no rows and no counts', async () => {
    const res = await createApp(config()).request(`/api/digest/${NIGHT_EMPTY}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: unknown[];
      badLines: number;
      counts: { ok: number; retry: number; fail: number };
    };
    expect(body.rows).toEqual([]);
    expect(body.badLines).toBe(0);
    expect(body.counts).toEqual({ ok: 0, retry: 0, fail: 0 });
  });

  it('200 for a night with a bad line, counting it in badLines only', async () => {
    const res = await createApp(config()).request(`/api/digest/${NIGHT_BAD}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { job: string }[];
      badLines: number;
      counts: { ok: number; retry: number; fail: number };
    };
    expect(body.badLines).toBe(1);
    expect(body.counts).toEqual({ ok: 1, retry: 0, fail: 1 });
    expect(body.rows.map((r) => r.job)).toEqual(['export-csv', 'mail-digest']);
  });
});

describe('page and JSON agree', () => {
  it('list the same jobs in the same order', async () => {
    const app = createApp(config());
    const page = textOf(await (await app.request(`/digest/${NIGHT_OK}`)).text());
    const json = (await (await app.request(`/api/digest/${NIGHT_OK}`)).json()) as {
      rows: { job: string }[];
    };

    const jsonJobs = json.rows.map((r) => r.job);
    // Position of each job's first appearance on the page, in page order.
    const pagePositions = jsonJobs.map((job) => page.indexOf(job));
    expect(pagePositions.every((i) => i >= 0)).toBe(true);
    const pageOrder = [...jsonJobs].sort((a, b) => page.indexOf(a) - page.indexOf(b));
    expect(pageOrder).toEqual(jsonJobs);
    expect(jsonJobs).toEqual(JOB_ORDER);
  });
});
