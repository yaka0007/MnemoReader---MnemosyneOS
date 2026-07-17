import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalStorage } from './lib/useLocalStorage';
import { bridge, isFramed } from './lib/bridge';
import {
  type Book, type LoadedBook, type ReaderSettings, DEFAULT_SETTINGS, LIBRARY_VAULT,
} from './lib/types';
import { splitSentences, detectChapters, chaptersFromMarks, chunkForIngest, hueFromTitle, guessMeta } from './lib/pdf';
import { ensureLibraryVault } from './lib/vaults';
import { SAMPLE_TITLE, SAMPLE_AUTHOR, SAMPLE_TEXT } from './lib/sample';
import { Library } from './components/Library';
import { Reader } from './components/Reader';
import { Toasts, type ToastMsg } from './components/Toast';
import { ImportOverlay, type ImportJob } from './components/ImportOverlay';
import { IconBook } from './components/Icons';

const SUPPORTED = ['epub', 'pdf', 'docx', 'rtf', 'txt', 'md', 'markdown', 'rst', 'csv', 'htm', 'html', 'org'];
const basename = (p: string) => p.split(/[\\/]/).pop() || p;
const extOf = (p: string) => { const b = basename(p); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i + 1).toLowerCase() : ''; };
const newId = () => `bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
/** Stable DJB2 hash — keys the per-vault idempotency map for catalogue sync. */
const hashString = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

export default function App() {
  const [books, setBooks] = useLocalStorage<Book[]>('books', []);
  const [settings, setSettings] = useLocalStorage<ReaderSettings>('settings', DEFAULT_SETTINGS);
  const [reader, setReader] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [importJob, setImportJob] = useState<ImportJob | null>(null);
  // Bumped after a Deep-OCR re-extract to remount the reader with the fresh text.
  const [reloadNonce, setReloadNonce] = useState(0);
  // Name of this app's walled-off sandbox vault (`APP-MNEMO-READER`) once ensured.
  const [sandboxVault, setSandboxVault] = useState<string | null>(null);

  const loadedCache = useRef<Map<string, LoadedBook>>(new Map());
  const toastId = useRef(0);

  const notify = useCallback((kind: ToastMsg['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { id, kind, text }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4600);
  }, [setToasts]);

  // On load: drop ephemeral demo books (their in-memory text is gone) and reset
  // any stale busy states left over from a previous session (never resumes ingest).
  useEffect(() => {
    setBooks(prev => {
      const cleaned = prev
        .filter(b => !b.id.startsWith('sample_'))
        .map(b => (['extracting', 'chaptering', 'vectorizing'].includes(b.ingest)
          ? { ...b, ingest: (b.archived ? 'archived' : 'idle') as Book['ingest'] } : b));
      return cleaned.length === prev.length && cleaned.every((b, i) => b === prev[i]) ? prev : cleaned;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── App sandbox vault (doc 58) ─────────────────────────────────────────────
  // Ensure the walled-off `APP-MNEMO-READER` vault at boot, then declare its
  // Vault Pad tile. The vault starts isolated (no federated RAG / neural map /
  // Dream State) until the human unlocks permanence from the host — so giving
  // Mnemosyne "the memory of the books" is the human's gated choice.
  useEffect(() => {
    if (!isFramed()) return;
    let cancelled = false;
    (async () => {
      try {
        const sb = await bridge.ensureSandbox();
        if (cancelled || !sb?.vault) return;
        setSandboxVault(sb.vault);
        await bridge.describeVaultTile({
          icon: '📚',
          metrics: [
            { label: 'Livres', spine: 'SOCIAL_CONTACT' },
            { label: 'Notes', spine: 'SOCIAL_NODE' },
          ],
        });
      } catch (err) {
        console.warn('[MnemoReader] sandbox vault ensure failed', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Catalogue sync — one SOCIAL_CONTACT chronicle per book so the tile shows an
  // exact book count. Idempotent: a per-vault localStorage hash map skips books
  // whose catalogue line is unchanged (the host also dedups by SHA-256).
  useEffect(() => {
    if (!sandboxVault?.startsWith('APP-') || books.length === 0) return;
    let cancelled = false;
    (async () => {
      const key = `mnemoreader_synced_v1:${sandboxVault}`;
      let synced: Record<string, string> = {};
      try { synced = JSON.parse(localStorage.getItem(key) || '{}'); } catch { synced = {}; }
      let pushed = 0;
      for (const b of books) {
        if (b.id.startsWith('sample_')) continue; // ephemeral demo book
        const parts = [`Book: ${b.title}.`];
        if (b.author) parts.push(`Author: ${b.author}.`);
        parts.push(`Format: ${b.ext.toUpperCase()}, ${b.chapters.length} chapters, ${b.sentenceCount} sentences.`);
        const content = parts.join(' ');
        const h = hashString(content);
        if (synced[b.id] === h) continue;
        try {
          await bridge.socialIngest(sandboxVault, content, 'SOCIAL_CONTACT');
          if (cancelled) return;
          synced[b.id] = h;
          pushed++;
        } catch (err) {
          console.warn(`[MnemoReader] catalogue sync failed for "${b.title}"`, err);
        }
      }
      if (pushed > 0 && !cancelled) {
        localStorage.setItem(key, JSON.stringify(synced));
        console.log(`[MnemoReader] ${pushed} book(s) catalogued into ${sandboxVault}`);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxVault, books]);

  /** Load the built-in demo text so the reader + voice can be tried without the host. */
  const loadSample = useCallback(() => {
    const id = `sample_${Date.now().toString(36)}`;
    const { sentences, offsets } = splitSentences(SAMPLE_TEXT);
    const chapters = detectChapters(SAMPLE_TEXT, offsets);
    loadedCache.current.set(id, { bookId: id, text: SAMPLE_TEXT, sentences, sentenceOffsets: offsets });
    const book: Book = {
      id, title: SAMPLE_TITLE, author: SAMPLE_AUTHOR, filePath: '', ext: 'txt',
      hue: hueFromTitle(SAMPLE_TITLE), addedAt: Date.now(),
      sentenceCount: sentences.length, chapters, progressSentence: 0,
      ingest: 'archived', archived: false,
    };
    setBooks(prev => [book, ...prev]);
    setReader(id);
  }, [setBooks]);

  const patchBook = useCallback((id: string, patch: Partial<Book>) => {
    setBooks(prev => prev.map(b => (b.id === id ? { ...b, ...patch } : b)));
  }, [setBooks]);

  /**
   * Extract → chapter → vectorize into an existing book row (also used for retry).
   * Reports each phase via `onPhase` (drives the URL-import overlay) and returns a
   * result so callers can react — while always setting the card state + toast itself.
   */
  const processInto = useCallback(async (
    id: string, filePath: string, title: string, onPhase?: (p: ImportJob['phase']) => void, forceOcr = false,
  ): Promise<{ ok: boolean; error?: string }> => {
    patchBook(id, { ingest: 'extracting', ingestError: undefined });
    onPhase?.('extracting');
    try {
      const res = await bridge.extractDocument(filePath, forceOcr);
      if (!res?.success || !res.data) throw new Error(res?.error || 'Extraction failed (host returned no data)');
      const text = res.data.text;
      if (!text.trim()) throw new Error('No readable text found — this looks like a scanned/image PDF the host could not OCR.');

      const { sentences, offsets } = splitSentences(text);
      // Prefer the document's own table of contents (EPUB) when it's rich enough;
      // a sparse/2-entry Gutenberg TOC falls back to heading detection.
      const chapters = (res.data.chapters?.length ?? 0) >= 3
        ? chaptersFromMarks(res.data.chapters!, text.length, offsets)
        : detectChapters(text, offsets);
      loadedCache.current.set(id, { bookId: id, text, sentences, sentenceOffsets: offsets });
      patchBook(id, {
        sentenceCount: sentences.length, chapters, truncated: res.data.truncated, ingest: 'vectorizing',
      });
      onPhase?.('vectorizing');

      // Vectorize + archive into the Library vault (SHA-256 dedup host-side). Best-effort —
      // a book stays fully readable even if the vault archive fails.
      await ensureLibraryVault();
      const chunks = chunkForIngest(sentences);
      let archived = 0;
      for (const c of chunks) {
        try { await bridge.ingest(LIBRARY_VAULT, c); archived++; }
        catch (err) { console.warn('[MnemoReader] ingest chunk failed', err); }
      }
      patchBook(id, { ingest: 'archived', archived: archived > 0 });
      notify('ok', `“${title}” — ${chapters.length} chapters ready. Tap to read.`);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[MnemoReader] ingest failed for', filePath, '→', msg, err);
      patchBook(id, { ingest: 'error', ingestError: msg });
      notify('err', `${title}: ${msg}`);
      return { ok: false, error: msg };
    }
  }, [notify, patchBook]);

  /** Full ingest pipeline for one file on disk (creates the book row, then processes).
   *  Returns the book id + result, or null when the file is rejected before processing. */
  const ingestPath = useCallback(async (
    filePath: string, onPhase?: (p: ImportJob['phase']) => void,
  ): Promise<{ id: string; ok: boolean; error?: string } | null> => {
    const ext = extOf(filePath);
    if (!SUPPORTED.includes(ext)) { notify('err', `Unsupported file type: .${ext}`); return null; }
    if (!isFramed()) { notify('err', 'Run MnemoReader inside Mnemosyne OS to import books.'); return null; }
    const dup = books.find(b => b.filePath === filePath);
    if (dup) { notify('info', 'That book is already in your library.'); return { id: dup.id, ok: true }; }

    const meta = guessMeta(basename(filePath));
    const id = newId();
    const book: Book = {
      id, title: meta.title, author: meta.author, filePath, ext,
      hue: hueFromTitle(meta.title), addedAt: Date.now(),
      sentenceCount: 0, chapters: [], progressSentence: 0,
      ingest: 'extracting', archived: false,
    };
    setBooks(prev => [book, ...prev]);
    const r = await processInto(id, filePath, meta.title, onPhase);
    return { id, ok: r.ok, error: r.error };
  }, [books, notify, processInto, setBooks]);

  const addFile = useCallback(async () => {
    try {
      const path = await bridge.selectFile(SUPPORTED);
      if (path) await ingestPath(path);
    } catch (err) { notify('err', err instanceof Error ? err.message : String(err)); }
  }, [ingestPath, notify]);

  const addFolder = useCallback(async () => {
    try {
      const dir = await bridge.selectFolder();
      if (!dir) return;
      const res = await bridge.readDir(dir);
      if (!res?.success || !res.files) { notify('err', res?.error || 'Could not read folder'); return; }
      const targets = res.files.filter(f => !f.isDirectory && SUPPORTED.includes(extOf(f.name)));
      if (!targets.length) { notify('info', 'No supported documents in that folder.'); return; }
      notify('info', `Importing ${targets.length} document${targets.length !== 1 ? 's' : ''}…`);
      for (const f of targets) await ingestPath(f.path);
    } catch (err) { notify('err', err instanceof Error ? err.message : String(err)); }
  }, [ingestPath, notify]);

  /** Download a document from a pasted link, then run the normal import pipeline —
   *  with a full ∞ overlay through every phase and a visible error state on failure. */
  const addUrl = useCallback(async (rawUrl: string) => {
    const url = rawUrl.trim();
    if (!/^https?:\/\//i.test(url)) { notify('err', 'Paste a full http(s) link (e.g. https://…/book.pdf).'); return; }
    if (!isFramed()) { notify('err', 'Run MnemoReader inside Mnemosyne OS to download books.'); return; }

    const PHASE_LABEL: Record<ImportJob['phase'], string> = {
      downloading: 'Downloading the file…',
      extracting: 'Reading the document…',
      vectorizing: 'Archiving into your library…',
      error: 'Import failed',
    };
    setImportJob({ phase: 'downloading', label: PHASE_LABEL.downloading });
    try {
      const res = await bridge.downloadUrl(url);
      if (!res?.success || !res.data?.path) throw new Error(res?.error || 'The link could not be downloaded.');

      const out = await ingestPath(res.data.path, (p) => setImportJob({ phase: p, label: PHASE_LABEL[p] }));
      if (!out) { setImportJob(null); return; }             // rejected pre-processing (toast shown)
      if (!out.ok) { setImportJob({ phase: 'error', label: PHASE_LABEL.error, error: out.error }); return; }

      setImportJob(null);
      setReader(out.id);                                     // auto-open so it's ready to listen
    } catch (err) {
      setImportJob({ phase: 'error', label: 'Download failed', error: err instanceof Error ? err.message : String(err) });
    }
  }, [ingestPath, notify]);

  /** Re-extract the current book with a proper OCR pass (ignores a poor embedded text
   *  layer), then remount the reader on the fresh text. Slow but high-quality. */
  const deepOcr = useCallback(async (book: Book) => {
    if (!isFramed()) { notify('err', 'Run MnemoReader inside Mnemosyne OS to OCR.'); return; }
    setImportJob({ phase: 'extracting', label: 'Deep OCR — analysing every page…' });
    const r = await processInto(book.id, book.filePath, book.title,
      (p) => setImportJob({ phase: p, label: p === 'extracting' ? 'Deep OCR — analysing every page…' : 'Archiving into your library…' }),
      true);
    if (!r.ok) { setImportJob({ phase: 'error', label: 'Deep OCR failed', error: r.error }); return; }
    setImportJob(null);
    setReloadNonce(n => n + 1); // remount the reader with the re-OCR'd text
  }, [notify, processInto]);

  const openBook = useCallback(async (book: Book) => {
    // A failed book: tapping it retries the import rather than dead-ending.
    if (book.ingest === 'error') { notify('info', `Retrying “${book.title}”…`); await processInto(book.id, book.filePath, book.title); return; }
    if (loadedCache.current.has(book.id)) { setReader(book.id); return; }
    if (!isFramed()) { notify('err', 'Open MnemoReader inside Mnemosyne OS to read this book.'); return; }
    notify('info', `Opening “${book.title}”…`);
    try {
      const res = await bridge.extractDocument(book.filePath);
      if (!res?.success || !res.data) throw new Error(res?.error || 'Extraction failed');
      const { sentences, offsets } = splitSentences(res.data.text);
      loadedCache.current.set(book.id, { bookId: book.id, text: res.data.text, sentences, sentenceOffsets: offsets });
      if (!book.chapters.length || book.sentenceCount !== sentences.length) {
        const chapters = (res.data.chapters?.length ?? 0) >= 3
          ? chaptersFromMarks(res.data.chapters!, res.data.text.length, offsets)
          : detectChapters(res.data.text, offsets);
        patchBook(book.id, { chapters, sentenceCount: sentences.length });
      }
      setReader(book.id);
    } catch (err) {
      notify('err', `Could not open: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [notify, patchBook, processInto]);

  // Right-click removes immediately (the sandboxed iframe blocks window.confirm();
  // the original file on disk is never touched, so this is safe + reversible by re-adding).
  const deleteBook = useCallback((book: Book) => {
    loadedCache.current.delete(book.id);
    setBooks(prev => prev.filter(b => b.id !== book.id));
    if (reader === book.id) setReader(null);
    notify('info', `Removed “${book.title}”.`);
  }, [reader, setBooks, notify]);

  const activeBook = reader ? books.find(b => b.id === reader) : null;
  const activeLoaded = reader ? loadedCache.current.get(reader) : null;

  return (
    <div className="app">
      {activeBook && activeLoaded ? (
        <Reader
          key={`${activeBook.id}:${reloadNonce}`}
          book={activeBook}
          loaded={activeLoaded}
          settings={settings}
          onChange={(patch) => setSettings(s => ({ ...s, ...patch }))}
          onProgress={(i) => { if (activeBook.progressSentence !== i) patchBook(activeBook.id, { progressSentence: i }); }}
          onBack={() => setReader(null)}
          onDeepOcr={() => deepOcr(activeBook)}
          notify={notify}
        />
      ) : (
        <>
          <div className="topbar">
            <div className="brand">
              <div className="brand-mark"><IconBook size={22} /></div>
              <div>
                <div className="brand-name">Mnemo<b>Reader</b></div>
                <div className="brand-sub">EPUB · PDF · DOCX & more · voice reading</div>
              </div>
            </div>
            <div className="topbar-spacer" />
            {!isFramed() && <span className="brand-sub">standalone preview — open inside Mnemosyne OS for full features</span>}
          </div>
          <Library
            books={books}
            onOpen={openBook}
            onDelete={deleteBook}
            onAddFile={addFile}
            onAddFolder={addFolder}
            onAddUrl={addUrl}
            onSample={loadSample}
            onDropPaths={(paths) => { void (async () => { for (const p of paths) await ingestPath(p); })(); }}
          />
        </>
      )}
      {importJob && <ImportOverlay job={importJob} onClose={() => setImportJob(null)} />}
      <Toasts items={toasts} />
    </div>
  );
}
