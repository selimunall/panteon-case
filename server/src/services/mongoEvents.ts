import type { Db } from 'mongodb';

export interface StreamEvent {
  streamId: string;   // Redis stream entry id
  playerId: string;
  delta: number;
  idempKey: string;
  clientTs: number;
}

/** Create the unique idempKey index once (idempotency gate) plus a query index. */
export async function ensureEventIndexes(db: Db): Promise<void> {
  const col = db.collection('earning_events');
  await col.createIndex({ idempKey: 1 }, { unique: true });
  await col.createIndex({ weekId: 1, playerId: 1 });
}

/**
 * Insert raw events; duplicates (re-delivered) are ignored via the unique index.
 * Returns the set of idempKeys that were NEWLY inserted (to be applied to Postgres).
 */
export async function insertRawEvents(db: Db, weekId: string, events: StreamEvent[]): Promise<Set<string>> {
  if (events.length === 0) return new Set();
  const now = new Date();
  const docs = events.map((e) => ({
    weekId,
    playerId: e.playerId,
    delta: e.delta,
    idempKey: e.idempKey,
    clientTs: new Date(e.clientTs),
    ingestedAt: now,
    streamId: e.streamId,
  }));

  try {
    await db.collection('earning_events').insertMany(docs, { ordered: false });
    return new Set(events.map((e) => e.idempKey)); // all new
  } catch (err: unknown) {
    const e = err as { writeErrors?: Array<{ code?: number; index?: number }> };
    const writeErrors = e.writeErrors ?? [];
    // Only a bulk write whose failures are ALL duplicate-key (E11000) is a partial success.
    // Any other failure (connection error, etc.) must propagate so the batch is NOT acked and
    // is redelivered — otherwise we would ack events that never landed in Mongo and lose them.
    if (writeErrors.length === 0 || writeErrors.some((w) => w.code !== 11000)) {
      throw err;
    }
    const dupKeys = new Set<string>();
    for (const we of writeErrors) {
      if (we.index !== undefined && docs[we.index]) dupKeys.add(docs[we.index]!.idempKey);
    }
    return new Set(events.filter((ev) => !dupKeys.has(ev.idempKey)).map((ev) => ev.idempKey));
  }
}
