import { PassThrough, type Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import pool, { type Q } from './db';
import { acquireBulkSlot } from './bulkOperation';

/** One connection and one snapshot for every page, count and related-table read. */
export async function openExportSnapshot(signal?: AbortSignal, readOnly = true) {
  signal?.throwIfAborted();
  const releaseSlot = await acquireBulkSlot(signal);
  let client;
  try { client = await pool.connect(); } catch (error) { releaseSlot(); throw error; }
  let released = false;
  const release = (destroy = false) => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', abort);
    client.release(destroy);
    releaseSlot();
  };
  // Destroying the connection also rolls back and interrupts any in-flight query.
  const abort = () => release(true);
  signal?.addEventListener('abort', abort, { once: true });
  const q: Q = (text, params) => {
    if (released) return Promise.reject(new Error('Export snapshot is closed.'));
    return client.query(text, params);
  };
  try {
    if (signal?.aborted) { abort(); signal.throwIfAborted(); }
    await q(`BEGIN ISOLATION LEVEL REPEATABLE READ ${readOnly ? 'READ ONLY' : 'READ WRITE'}`);
    await q("SET LOCAL statement_timeout = '60s'");
    await q("SET LOCAL idle_in_transaction_session_timeout = '60s'");
  } catch (error) {
    release(true);
    throw error;
  }
  return {
    q,
    abort,
    async commit() {
      try {
        const result = await q('COMMIT');
        // PostgreSQL answers ROLLBACK when a caller caught a statement error
        // without restoring the transaction. Do not send a successful download.
        if (result.command !== 'COMMIT') throw new Error('Export transaction rolled back.');
      } catch (error) { release(true); throw error; }
      release();
    },
  };
}

export async function withExportSnapshot<T>(fn: (q: Q) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const snapshot = await openExportSnapshot(signal);
  try {
    const result = await fn(snapshot.q);
    await snapshot.commit();
    return result;
  } catch (error) {
    snapshot.abort();
    throw error;
  }
}

/**
 * Prepare before sending headers; finish the response only after COMMIT succeeds.
 * The intermediate stream lets XLSX writers end their output without ending HTTP
 * before invoice export markers/audit commit. Cancel/error closes the DB connection.
 */
export async function snapshotExport<T>(
  signal: AbortSignal,
  prepare: (q: Q) => Promise<{
    metadata: T;
    write: (output: Writable) => Promise<void>;
    complete?: () => Promise<void>;
  }>,
  readOnly = true,
) {
  const snapshot = await openExportSnapshot(signal, readOnly);
  const output = new PassThrough();
  const writer = new PassThrough();
  const iterator = output[Symbol.asyncIterator]();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (cancelled) return;
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      fail(reason);
    },
  });
  const fail = (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error('Export cancelled.');
    snapshot.abort();
    writer.destroy(error);
    output.destroy(error);
  };
  writer.on('error', fail);
  output.on('error', () => {});
  output.once('close', () => {
    if (!output.writableFinished) fail(new Error('Export download cancelled.'));
  });
  const abort = () => fail(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  // Bound a snapshot even if a client remains connected but stops reading.
  const deadline = setTimeout(() => fail(new Error('Export exceeded five minutes.')), 300_000);
  deadline.unref();
  const cleanup = () => {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  };
  const writerFinished = finished(writer);
  // Observe errors immediately, including errors during prepare.
  void writerFinished.catch(() => {});
  try {
    signal.throwIfAborted();
    const prepared = await prepare(snapshot.q);
    writer.pipe(output, { end: false });
    const completion = (async () => {
      try {
        await prepared.write(writer);
        if (!writer.writableEnded) writer.end();
        await writerFinished;
        await prepared.complete?.();
        await snapshot.commit();
        output.end();
      } catch (error) {
        fail(error);
        throw error;
      } finally { cleanup(); }
    })();
    // Route handlers return while the writer runs; failure is delivered via the body.
    void completion.catch(() => {});
    return { body, metadata: prepared.metadata, completion };
  } catch (error) {
    fail(error);
    cleanup();
    throw error;
  }
}
