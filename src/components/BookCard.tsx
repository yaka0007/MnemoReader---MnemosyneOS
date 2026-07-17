import type { Book } from '../lib/types';
import { IconBook, IconX } from './Icons';

function ProgressRing({ pct }: { pct: number }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const off = c * (1 - pct);
  return (
    <svg className="ring" width="34" height="34" viewBox="0 0 34 34">
      <circle className="ring-track" cx="17" cy="17" r={r} fill="none" strokeWidth="3" />
      <circle
        className="ring-fill" cx="17" cy="17" r={r} fill="none" strokeWidth="3"
        strokeLinecap="round" strokeDasharray={c} strokeDashoffset={off}
        transform="rotate(-90 17 17)"
      />
      <text className="ring-label" x="17" y="20" textAnchor="middle">{Math.round(pct * 100)}</text>
    </svg>
  );
}

export function BookCard({ book, index, onOpen, onDelete }: { book: Book; index: number; onOpen: (b: Book) => void; onDelete: (b: Book) => void }) {
  const pct = book.sentenceCount > 1 ? book.progressSentence / (book.sentenceCount - 1) : 0;
  const busy = book.ingest === 'extracting' || book.ingest === 'chaptering' || book.ingest === 'vectorizing';
  const h = book.hue;
  const coverBg = `linear-gradient(150deg, hsl(${h} 62% 42%), hsl(${(h + 40) % 360} 55% 22%))`;

  return (
    <div
      className="card"
      style={{ animationDelay: `${Math.min(index * 40, 400)}ms` }}
      onClick={() => onOpen(book)}
      onContextMenu={(e) => { e.preventDefault(); onDelete(book); }}
      title="Right-click to remove"
    >
      <div className={`cover ${busy ? 'shimmer' : ''}`} style={{ background: coverBg }}>
        <div className="cover-spine" />
        <div className="cover-glyph"><IconBook size={20} /></div>
        <button
          className="card-del"
          title="Remove from library (the file on disk is untouched)"
          onClick={(e) => { e.stopPropagation(); onDelete(book); }}
        >
          <IconX size={16} />
        </button>

        {busy && (
          <div className="badge"><span className="dot" />
            {book.ingest === 'extracting' ? 'Reading' : book.ingest === 'vectorizing' ? 'Vectorizing' : 'Parsing'}
          </div>
        )}
        {book.ingest === 'archived' && <div className="badge archived">Ready</div>}
        {book.ingest === 'error' && (
          <div className="badge error" title={book.ingestError || 'Import failed'}>Failed · tap to retry</div>
        )}

        <div className="cover-title">{book.title}</div>
        {book.author && <div className="cover-author">{book.author}</div>}
      </div>

      <div className="card-meta">
        <span className="card-meta-title">{book.chapters.length ? `${book.chapters.length} chapters` : '—'}</span>
        {pct > 0 && <ProgressRing pct={pct} />}
      </div>
    </div>
  );
}
