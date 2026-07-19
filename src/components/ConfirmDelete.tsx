import type { Book } from '../lib/types';

/**
 * Deletion validation overlay — replaces the old instant right-click removal.
 * The sandboxed iframe blocks window.confirm(), so this is an in-app modal.
 *
 * Governance: it states EXACTLY what is deleted and what is not. What was
 * archived into the Mnemosyne vault deliberately stays — memory is governed by
 * the human from the host (Governance / Neural Map), never silently from a
 * cartridge. A host-gated "also forget the archived memory" flow is planned
 * (needs per-book tagging host-side); until then this modal makes no promise
 * it cannot keep.
 */
export function ConfirmDelete({ book, onCancel, onConfirm }: {
  book: Book;
  onCancel: () => void;
  onConfirm: (book: Book) => void;
}) {
  return (
    <div className="import-overlay" onClick={onCancel}>
      <div className="import-card" onClick={(e) => e.stopPropagation()}>
        <div className="import-title">Remove “{book.title}”?</div>
        <div className="import-msg" style={{ textAlign: 'left' }}>
          <p style={{ margin: '0 0 8px' }}>• Removes the book and its local reading copy from MnemoReader.</p>
          <p style={{ margin: '0 0 8px' }}>• The original file on disk is <strong>never</strong> touched.</p>
          <p style={{ margin: 0 }}>
            • What you archived into your Mnemosyne vault <strong>stays in your memory</strong> — you govern
            it from Mnemosyne OS (Governance / Neural Map), not from this app.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onConfirm(book)}>Remove book</button>
        </div>
      </div>
    </div>
  );
}
