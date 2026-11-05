/**
 * Ticket 14 — the two promise shapes every IndexedDB call in this app needs
 * (DECISIONS/0023 P1–P10).
 *
 * IndexedDB is request-and-event API; everything else here is `async`. Two rules make the seam safe:
 *
 * - **A transaction completes, it does not merely return.** `run()` resolves on `oncomplete`, and rejects on
 *   `onerror`/`onabort`. Resolving on the last request's success instead would report a write as durable
 *   before it has been — exactly the window §10 line 750 forbids ("no partial migration left applied").
 * - **A request error aborts its transaction by itself.** A `put` that throws `DataCloneError` fails at
 *   request time and the transaction follows; `run()` surfaces the transaction's error, so a caller cannot
 *   mistake a half-applied write for success.
 *
 * This is the only module that touches request events; every other storage file reads as ordinary async.
 */

/** A request's own result, as a promise. Errors reject; the transaction then aborts on its own. */
export function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(String(request.error)));
  });
}

/**
 * Runs one transaction to completion. `work` issues the requests; the transaction's own lifecycle decides
 * when the caller hears back.
 */
export function run<T>(
  database: IDBDatabase,
  stores: readonly string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(stores as string[], mode);
    let result: T;
    let failed = false;
    // A sync throw inside `work` must reject this promise *and* let the transaction abort. IndexedDB aborts
    // on an uncaught error in the handler; rethrowing here would hide the value from `onabort`.
    void Promise.resolve()
      .then(() => work(transaction))
      .then(
        (value) => {
          result = value as T;
        },
        (error) => {
          failed = true;
          try {
            transaction.abort();
          } catch {
            reject(error);
          }
          reject(error);
        },
      );
    transaction.oncomplete = () => {
      if (!failed) resolve(result!);
    };
    transaction.onerror = () => {
      if (!failed) reject(transaction.error);
    };
    transaction.onabort = () => {
      if (!failed) reject(transaction.error ?? new Error("transaction aborted"));
    };
  });
}

/** Reads a whole store. P2's scale assumption — one creator's ledger — makes this the right shape. */
export function readAll<T>(transaction: IDBTransaction, store: string): Promise<T[]> {
  return done(transaction.objectStore(store).getAll() as IDBRequest<T[]>);
}

export function readOne<T>(transaction: IDBTransaction, store: string, key: IDBValidKey): Promise<T | undefined> {
  return done(transaction.objectStore(store).get(key) as IDBRequest<T | undefined>);
}

export function countOf(transaction: IDBTransaction, store: string): Promise<number> {
  return done(transaction.objectStore(store).count() as IDBRequest<number>);
}

/** Opens a request chain that must not resolve before its transaction completes. */
export function put(transaction: IDBTransaction, store: string, value: unknown): Promise<unknown> {
  return done(transaction.objectStore(store).put(value as never));
}

export function remove(transaction: IDBTransaction, store: string, key: IDBValidKey): Promise<undefined> {
  return done(transaction.objectStore(store).delete(key) as IDBRequest<undefined>);
}
