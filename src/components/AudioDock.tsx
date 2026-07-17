import { useEffect, useRef, useState } from 'react';
import type { PlayerState } from '../lib/voice';
import type { ReaderSettings } from '../lib/types';
import {
  IconPlay, IconPause, IconBack15, IconFwd15, IconPrev, IconNext, IconGauge, IconMoon,
} from './Icons';

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
const SLEEPS = [0, 5, 15, 30, 45, 60];

interface DockProps {
  state: PlayerState;
  chapterTitle: string;
  sentenceIndex: number;
  sentenceCount: number;
  pct: number;
  ticks: number[];
  settings: ReaderSettings;
  sleepRemaining: number | null;
  onToggle: () => void;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onSkip: (deltaSentences: number) => void;
  onSeekPct: (pct: number) => void;
  onChange: (patch: Partial<ReaderSettings>) => void;
}

type PopId = 'speed' | 'sleep' | null;

export function AudioDock(props: DockProps) {
  const { state, settings } = props;
  const [pop, setPop] = useState<PopId>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close popovers on outside click.
  useEffect(() => {
    if (!pop) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPop(null);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pop]);

  const seekFromEvent = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    props.onSeekPct(p);
  };

  const busy = state === 'buffering';
  const playing = state === 'playing';

  return (
    <div className="dock" ref={rootRef}>
      {/* scrubber */}
      <div className="scrub">
        <span className="scrub-time">{Math.round(props.pct * 100)}%</span>
        <div
          className="track" ref={trackRef}
          onClick={(e) => seekFromEvent(e.clientX)}
        >
          <div className="track-fill" style={{ width: `${props.pct * 100}%` }} />
          <div className="track-ticks">
            {props.ticks.map((t, i) => <span key={i} className="track-tick" style={{ left: `${t * 100}%` }} />)}
          </div>
          <div className="track-thumb" style={{ left: `${props.pct * 100}%` }} />
        </div>
        <span className="scrub-time">{props.sentenceIndex + 1}/{props.sentenceCount}</span>
      </div>

      <div className="dock-row">
        <div className="dock-now">
          <div className="dock-now-ch">{props.chapterTitle || 'Ready'}</div>
          <div className="dock-now-sub">
            {playing && <span className="eq" aria-hidden="true"><i /><i /><i /><i /></span>}
            <span>
              {busy ? 'Synthesizing…' : playing ? 'Reading aloud' : state === 'paused' ? 'Paused' : 'Press play to listen'}
              {props.sleepRemaining != null && ` · 💤 ${props.sleepRemaining}m`}
            </span>
          </div>
        </div>

        <div className="dock-transport">
          <button className="icon-btn" title="Previous chapter" onClick={props.onPrevChapter}><IconPrev size={18} /></button>
          <button className="icon-btn" title="Back" onClick={() => props.onSkip(-1)}><IconBack15 size={18} /></button>
          <button className={`play-fab ${busy ? 'buffering' : playing ? 'playing' : ''}`} title={playing ? 'Pause' : 'Play'} onClick={props.onToggle}>
            {playing ? <IconPause size={24} /> : <IconPlay size={24} />}
          </button>
          <button className="icon-btn" title="Forward" onClick={() => props.onSkip(1)}><IconFwd15 size={18} /></button>
          <button className="icon-btn" title="Next chapter" onClick={props.onNextChapter}><IconNext size={18} /></button>
        </div>

        <div className="dock-tools">
          <div className="pop-anchor">
            <button className={`chip ${pop === 'speed' ? 'on' : ''}`} onClick={() => setPop(pop === 'speed' ? null : 'speed')}>
              <IconGauge size={15} /> {settings.rate}×
            </button>
            {pop === 'speed' && (
              <div className="pop">
                <div className="pop-title">Speed</div>
                {SPEEDS.map(s => (
                  <button key={s} className={`pop-opt ${settings.rate === s ? 'sel' : ''}`} onClick={() => { props.onChange({ rate: s }); setPop(null); }}>
                    {s}× {settings.rate === s && '✓'}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="pop-anchor">
            <button className={`chip ${settings.sleepMinutes > 0 ? 'on' : ''}`} onClick={() => setPop(pop === 'sleep' ? null : 'sleep')}>
              <IconMoon size={15} />
            </button>
            {pop === 'sleep' && (
              <div className="pop">
                <div className="pop-title">Sleep timer</div>
                {SLEEPS.map(m => (
                  <button key={m} className={`pop-opt ${settings.sleepMinutes === m ? 'sel' : ''}`} onClick={() => { props.onChange({ sleepMinutes: m }); setPop(null); }}>
                    {m === 0 ? 'Off' : `${m} minutes`} {settings.sleepMinutes === m && '✓'}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
