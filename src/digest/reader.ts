// Plan morning-digest § 1: read runs/<night>.jsonl into one DigestRow per job.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, JobStatus, NightDigest, ReadNight } from './types.js';

// One valid log line. `time` is the instant, for ordering only; `at` is kept as written.
type Entry = {
  at: string;
  time: number;
  job: string;
  status: JobStatus;
  owner: string | null;
  error: string | null;
};

const NIGHT = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is JobStatus {
  return value === 'ok' || value === 'retry' || value === 'fail';
}

function isOwner(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

// A log line → an Entry, or null when it isn't valid JSON or isn't a valid entry.
function parseLine(line: string): Entry | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const { at, job, status, owner, error } = value;
  if (typeof at !== 'string' || !ISO_WITH_OFFSET.test(at)) return null;
  const time = Date.parse(at);
  if (Number.isNaN(time)) return null;
  if (typeof job !== 'string' || job === '') return null;
  if (!isStatus(status) || !isOwner(owner)) return null;
  if (error !== undefined && typeof error !== 'string') return null;
  return { at, time, job, status, owner, error: error ?? null };
}

// entries: one job's lines in log order, never empty. Ties in time keep log order.
function toRow(job: string, entries: Entry[]): DigestRow {
  let first = entries[0];
  let last = entries[0];
  for (const entry of entries) {
    if (entry.time < first.time) first = entry;
    if (entry.time >= last.time) last = entry;
  }
  return {
    job,
    owner: last.owner,
    runs: entries.length,
    retries: entries.filter((entry) => entry.status === 'retry').length,
    lastStatus: last.status,
    lastError: last.error,
    firstAt: first.at,
    lastAt: last.at,
  };
}

function isMissingFile(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

export const readNight: ReadNight = (runsDir, night) => {
  // Nights are YYYY-MM-DD (as on disk); anything else has no file, and never reaches the path.
  if (!NIGHT.test(night)) return null;

  let text: string;
  try {
    text = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (err) {
    if (isMissingFile(err)) return null;
    throw err;
  }

  const byJob = new Map<string, Entry[]>();
  const counts: NightDigest['counts'] = { ok: 0, retry: 0, fail: 0 };
  let badLines = 0;

  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const entry = parseLine(line);
    if (entry === null) {
      badLines += 1;
      continue;
    }
    counts[entry.status] += 1;
    const entries = byJob.get(entry.job);
    if (entries) entries.push(entry);
    else byJob.set(entry.job, [entry]);
  }

  const rows = [...byJob]
    .map(([job, entries]) => toRow(job, entries))
    .sort((a, b) => (a.job < b.job ? -1 : a.job > b.job ? 1 : 0));

  return { night, rows, badLines, counts };
};
