// Plan morning-digest § 1. The contract the reader (#2) and the digest page parts build against.

export type JobStatus = 'ok' | 'retry' | 'fail';

// One row per job in the night's run log. Times keep the offset from the log, never UTC.
export type DigestRow = {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  lastStatus: JobStatus;
  lastError: string | null;
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  night: string; // YYYY-MM-DD
  rows: DigestRow[]; // sorted by job
  badLines: number; // lines that didn't parse
  counts: { ok: number; retry: number; fail: number }; // log lines by status, bad lines excluded
};

// null = no file for that night. `readNight: ReadNight` is exported from src/digest/reader.ts (#2).
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
