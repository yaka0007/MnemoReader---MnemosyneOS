import type { Book } from '../lib/types';

export function ChapterRail({
  book, activeChapter, onJump,
}: {
  book: Book;
  activeChapter: number;
  onJump: (chapterIndex: number) => void;
}) {
  return (
    <aside className="rail">
      <div className="rail-head">
        <div className="rail-book-title">{book.title}</div>
        {book.author && <div className="rail-book-author">{book.author}</div>}
      </div>
      <div className="rail-list">
        {book.chapters.map((ch, i) => (
          <button
            key={ch.id}
            className={`chapter ${i === activeChapter ? 'active' : ''}`}
            onClick={() => onJump(i)}
          >
            <span className="chapter-idx">{String(i + 1).padStart(2, '0')}</span>
            <span className="chapter-name">{ch.title}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
