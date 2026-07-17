export interface ToastMsg { id: number; kind: 'info' | 'ok' | 'err'; text: string }

export function Toasts({ items }: { items: ToastMsg[] }) {
  if (!items.length) return null;
  return (
    <div className="toasts">
      {items.map(t => (
        <div key={t.id} className={`toast ${t.kind === 'err' ? 'err' : t.kind === 'ok' ? 'ok' : ''}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
