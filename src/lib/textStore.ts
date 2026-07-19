/**
 * textStore.ts — durable full-text cache for imported books (IndexedDB).
 *
 * Why: the library used to re-extract from the ORIGINAL file path on every
 * open, so moving/renaming/deleting the source file bricked the book forever
 * (seen in beta: ENOENT toast on a .docx whose folder had been renamed).
 * A library must outlive its sources: the extracted text is persisted here at
 * import time and opens read from this cache — the source file is only needed
 * again for source-bound features (PDF compare view, Deep OCR).
 *
 * localStorage is NOT an option: it holds the book metadata already and its
 * ~5 MB quota would overflow after a couple of books. IndexedDB has no such
 * practical limit. Sentences/offsets are recomputed on load (cheap) so the
 * store stays a plain { bookId → text } map with no schema to migrate.
 */

const DB_NAME = 'mnemoreader';
const STORE = 'bookTexts';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error ?? new Error('IndexedDB open failed')); };
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

/** Persist a book's full text. Best-effort: a failure must never block an import. */
export async function saveText(bookId: string, text: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = tx(db, 'readwrite').put(text, bookId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB put failed'));
    });
  } catch (err) {
    console.warn(`[MnemoReader] text cache save failed for ${bookId} — the book stays readable from its source file:`, err);
  }
}

/** The cached full text, or null when this book was never cached (pre-cache import). */
export async function loadText(bookId: string): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise<string | null>((resolve, reject) => {
      const req = tx(db, 'readonly').get(bookId);
      req.onsuccess = () => resolve(typeof req.result === 'string' && req.result.length > 0 ? req.result : null);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'));
    });
  } catch (err) {
    console.warn(`[MnemoReader] text cache read failed for ${bookId}:`, err);
    return null;
  }
}

/** Erase a book's cached text (the delete flow — the source file is never touched). */
export async function deleteText(bookId: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = tx(db, 'readwrite').delete(bookId);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('IndexedDB delete failed'));
    });
  } catch (err) {
    console.warn(`[MnemoReader] text cache delete failed for ${bookId}:`, err);
  }
}
