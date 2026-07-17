import { useMemo, useState } from 'react';
import type { Book } from '../lib/types';
import { BookCard } from './BookCard';
import { IconBook, IconFolder, IconPlus, IconSparkle, IconLink } from './Icons';

interface LibraryProps {
  books: Book[];
  onOpen: (b: Book) => void;
  onDelete: (b: Book) => void;
  onAddFile: () => void;
  onAddFolder: () => void;
  onAddUrl: (url: string) => void;
  onSample: () => void;
  onDropPaths: (paths: string[]) => void;
}

/** Compact "paste a link" field — Enter or the button submits an http(s) document URL. */
function LinkBar({ onAddUrl, autoFocus }: { onAddUrl: (url: string) => void; autoFocus?: boolean }) {
  const [url, setUrl] = useState('');
  const submit = () => { const u = url.trim(); if (u) { onAddUrl(u); setUrl(''); } };
  return (
    <div className="linkbar">
      <IconLink size={16} />
      <input
        type="url"
        value={url}
        autoFocus={autoFocus}
        placeholder="Paste a book link (EPUB, PDF…)  https://…/book.epub"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      />
      <button className="btn btn-primary" onClick={submit} disabled={!url.trim()}>Download</button>
    </div>
  );
}

export function Library({ books, onOpen, onDelete, onAddFile, onAddFolder, onAddUrl, onSample, onDropPaths }: LibraryProps) {
  const [q, setQ] = useState('');
  const [drag, setDrag] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? books.filter(b => b.title.toLowerCase().includes(needle) || (b.author ?? '').toLowerCase().includes(needle))
      : books;
    return [...list].sort((a, b) => b.addedAt - a.addedAt);
  }, [books, q]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const paths: string[] = [];
    for (const f of Array.from(e.dataTransfer.files)) {
      // Electron exposes the absolute path on dropped File objects.
      const p = (f as File & { path?: string }).path;
      if (p) paths.push(p);
    }
    if (paths.length) onDropPaths(paths);
  };

  if (books.length === 0) {
    return (
      <div className="library">
        <div className="empty-wrap">
          <div className="empty-inner">
            <div className="empty-orb"><IconBook size={38} /></div>
            <h2 style={{ fontSize: 24, margin: '0 0 8px', letterSpacing: '-0.02em' }}>Your library is empty</h2>
            <p style={{ color: 'var(--text-faint)', margin: '0 0 24px', lineHeight: 1.6 }}>
              Add a book in any format — EPUB, PDF, DOCX, RTF, TXT, HTML, Markdown — and MnemoReader
              will read it aloud, extracting the text, finding chapters, and vectorizing it into your
              Library vault. Most formats (EPUB, DOCX, TXT, HTML…) need no OCR.
            </p>
            <div
              className={`dropzone ${drag ? 'drag' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={() => setDrag(false)}
              onDrop={handleDrop}
            >
              <div style={{ display: 'flex', justifyContent: 'center', gap: 10, color: 'var(--text-dim)' }}>
                <IconSparkle size={26} />
              </div>
              <h3>Drop a book here</h3>
              <p>EPUB, PDF, DOCX, TXT… — or pick one from disk</p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                <button className="btn btn-primary" onClick={onAddFile}><IconPlus size={16} /> Add a book</button>
                <button className="btn" onClick={onAddFolder}><IconFolder size={16} /> Import folder</button>
              </div>
              <div style={{ marginTop: 14 }}><LinkBar onAddUrl={onAddUrl} /></div>
              <button className="btn btn-ghost" onClick={onSample} style={{ marginTop: 12 }}>
                <IconSparkle size={15} /> Try it with a sample story
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="library"
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={handleDrop}
    >
      <div className="library-head">
        <div>
          <div className="library-title">Library</div>
          <div className="library-count">{books.length} book{books.length !== 1 ? 's' : ''}</div>
        </div>
        <div className="library-actions">
          <div className="search">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title or author…" />
          </div>
          <button className={`btn ${linkOpen ? 'on' : ''}`} onClick={() => setLinkOpen(v => !v)}><IconLink size={16} /> Link</button>
          <button className="btn" onClick={onAddFolder}><IconFolder size={16} /> Folder</button>
          <button className="btn btn-primary" onClick={onAddFile}><IconPlus size={16} /> Add book</button>
        </div>
      </div>

      {linkOpen && <LinkBar onAddUrl={(u) => { onAddUrl(u); setLinkOpen(false); }} autoFocus />}

      <div className="grid">
        {filtered.map((b, i) => (
          <BookCard key={b.id} book={b} index={i} onOpen={onOpen} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}
