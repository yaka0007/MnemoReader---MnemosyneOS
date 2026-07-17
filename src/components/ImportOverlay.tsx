import { IconX } from './Icons';

export type ImportPhase = 'downloading' | 'extracting' | 'vectorizing' | 'error';
export interface ImportJob { phase: ImportPhase; label: string; error?: string }

const INF_PATH = 'M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z';

/** Full-screen ∞ loader for URL imports (download → extract → archive), with a
 *  visible error state so a failed link never dead-ends silently. */
export function ImportOverlay({ job, onClose }: { job: ImportJob; onClose: () => void }) {
  const isError = job.phase === 'error';
  return (
    <div className="import-overlay" onClick={isError ? onClose : undefined}>
      <div className="import-card" onClick={(e) => e.stopPropagation()}>
        {isError ? (
          <>
            <div className="import-x-badge"><IconX size={26} /></div>
            <div className="import-title">{job.label}</div>
            {job.error && <div className="import-msg">{job.error}</div>}
            <button className="btn btn-primary" onClick={onClose}>Close</button>
          </>
        ) : (
          <>
            <svg className="inf-loader" viewBox="0 0 24 24" width="66" height="38" aria-hidden="true">
              <path className="inf-bg" d={INF_PATH} />
              <path className="inf-trace" pathLength={100} d={INF_PATH} />
            </svg>
            <div className="import-label">{job.label}</div>
          </>
        )}
      </div>
    </div>
  );
}
