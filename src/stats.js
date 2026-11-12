// Glucose statistics (time-weighted) and chart downsampling.

const MAX_GAP_MS = 20 * 60_000; // a reading never counts for longer than this
const LAST_READING_MS = 60_000;

// rows: [{ ts, value }] ascending. Each reading is weighted by how long it "held" until the next one,
// so sparse backfilled history and dense 1-minute polling don't skew the result.
export function computeStats(rows, { low, high, now, rangeMs }) {
  if (!rows.length) return null;
  let total = 0;
  let sum = 0;
  let below = 0;
  let above = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < rows.length; i++) {
    const { ts, value } = rows[i];
    const next = i + 1 < rows.length ? rows[i + 1].ts : Math.min(now, ts + LAST_READING_MS);
    const dt = Math.max(0, Math.min(next - ts, MAX_GAP_MS)) || LAST_READING_MS;
    total += dt;
    sum += value * dt;
    if (value < low) below += dt;
    else if (value > high) above += dt;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const round1 = (n) => Math.round(n * 10) / 10;
  const avg = sum / total;
  const pctBelow = round1((below / total) * 100);
  const pctAbove = round1((above / total) * 100);
  return {
    count: rows.length,
    avg: Math.round(avg),
    gmi: round1(3.31 + 0.02392 * avg), // estimated A1C from mean glucose (mg/dL)
    min,
    max,
    tir: { below: pctBelow, inRange: round1(100 - pctBelow - pctAbove), above: pctAbove },
    coverage: rangeMs ? Math.min(1, round1(total / rangeMs * 100) / 100) : null,
  };
}

// Reduces rows to at most maxPoints by averaging within equal time buckets.
export function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const first = rows[0].ts;
  const bucketMs = Math.ceil((rows[rows.length - 1].ts - first + 1) / maxPoints);
  const out = [];
  let bucket = -1;
  let acc = null;
  for (const r of rows) {
    const b = Math.floor((r.ts - first) / bucketMs);
    if (b !== bucket) {
      if (acc) out.push(finish(acc));
      bucket = b;
      acc = { n: 0, tsSum: 0, valSum: 0, trend: null };
    }
    acc.n += 1;
    acc.tsSum += r.ts;
    acc.valSum += r.value;
    if (r.trend != null) acc.trend = r.trend;
  }
  if (acc) out.push(finish(acc));
  return out;
}

function finish(a) {
  return { ts: Math.round(a.tsSum / a.n), value: Math.round(a.valSum / a.n), trend: a.trend };
}
