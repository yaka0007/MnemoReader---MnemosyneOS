import { useEffect, useMemo, useRef, useState } from 'react';
import type { Book, LoadedBook, ReaderSettings } from '../lib/types';
import { ReaderPlayer, warmBrowserVoices, type PlayerState, type BrowserVoiceInfo } from '../lib/voice';
import { detectLang, pickVoiceForLang } from '../lib/lang';
import { bridge, isFramed } from '../lib/bridge';
import { ChapterRail } from './ChapterRail';
import { AudioDock } from './AudioDock';
import { PdfCompare } from './PdfCompare';
import { IconChevron, IconColumns, IconSparkle } from './Icons';

interface ReaderProps {
  book: Book;
  loaded: LoadedBook;
  settings: ReaderSettings;
  onChange: (patch: Partial<ReaderSettings>) => void;
  onProgress: (sentenceIndex: number) => void;
  onBack: () => void;
  onDeepOcr: () => void;
  notify: (kind: 'info' | 'ok' | 'err', text: string) => void;
}

export function Reader({ book, loaded, settings, onChange, onProgress, onBack, onDeepOcr, notify }: ReaderProps) {
  const { sentences } = loaded;
  const count = sentences.length;

  const [activeSentence, setActiveSentence] = useState(Math.min(book.progressSentence, Math.max(0, count - 1)));
  const [activeWord, setActiveWord] = useState<{ start: number; end: number } | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>('idle');
  // True once audio has actually played — gates the full-screen warm-up overlay
  // so it only shows on the initial cold start, never between sentences.
  const [everPlayed, setEverPlayed] = useState(false);
  const [browserVoices, setBrowserVoices] = useState<BrowserVoiceInfo[]>([]);
  const [piper, setPiper] = useState<{ ready: boolean; voices: string[] }>({ ready: false, voices: [] });
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);
  // User-picked voice in the dock (overrides the language-matched one for this session).
  const [manualVoice, setManualVoice] = useState<string | null>(null);
  // Side-by-side original-PDF compare pane (to eyeball OCR quality vs the source).
  const [compare, setCompare] = useState(false);
  const canCompare = isFramed() && book.ext === 'pdf' && !!book.filePath;

  const playerRef = useRef<ReaderPlayer | null>(null);
  const sentenceElRef = useRef<HTMLSpanElement | null>(null);

  // Latest callbacks/settings for the player hooks (avoids stale closures without re-creating the player).
  const live = useRef({ onProgress, onChange, notify, engine: settings.engine });
  live.current = { onProgress, onChange, notify, engine: settings.engine };

  // Speak the document in its own language: detect it, then pick a matching voice
  // for the active engine. A manual pick in the dock wins; else fall back to seeded.
  const bookLang = useMemo(() => detectLang(loaded.text), [loaded.text]);
  const effectiveVoice = useMemo(
    () => manualVoice ?? pickVoiceForLang(settings.engine, bookLang, { browser: browserVoices, piper: piper.voices }) ?? settings.voice,
    [manualVoice, settings.engine, settings.voice, bookLang, browserVoices, piper.voices],
  );

  // ── chapter math ──────────────────────────────────────────────────────────
  const chapterOf = useMemo(() => {
    const starts = book.chapters.map(c => c.sentenceStart);
    return (idx: number) => {
      let ans = 0;
      for (let i = 0; i < starts.length; i++) { if (starts[i] <= idx) ans = i; else break; }
      return ans;
    };
  }, [book.chapters]);

  const activeChapter = chapterOf(activeSentence);
  const chapter = book.chapters[activeChapter];
  const chapterEndSentence = activeChapter + 1 < book.chapters.length
    ? book.chapters[activeChapter + 1].sentenceStart
    : count;
  const ticks = useMemo(
    () => book.chapters.map(c => (count > 1 ? c.sentenceStart / (count - 1) : 0)),
    [book.chapters, count]
  );

  // ── create the player once (Reader is keyed by book id in App) ──────────────
  useEffect(() => {
    warmBrowserVoices().then(setBrowserVoices);

    // Reuse the voice already configured in the host (Settings → Voice), unless the
    // user has explicitly chosen one inside MnemoReader (engine changed or voice set).
    bridge.voiceConfig().then((vc) => {
      // Follow the engine selected in the host (Settings → Voice) on every open,
      // UNLESS the user picked a voice inside MnemoReader. The voice itself is chosen
      // by the document's language (effectiveVoice). Adopt the host speed only on a
      // fresh reader (rate still default) so a dock speed change sticks.
      if (vc && !settings.voiceOverridden) {
        const patch: Partial<ReaderSettings> = { engine: vc.engine };
        if (settings.rate === 1) patch.rate = Math.max(0.5, Math.min(2, vc.speed || 1));
        live.current.onChange(patch);
      }
    }).catch(() => { /* keep defaults */ });

    bridge.ttsStatus().then(async (st) => {
      const ready = !!st?.success && !!st.data?.ready;
      let voices: string[] = [];
      if (ready) {
        const vr = await bridge.ttsVoices().catch(() => null);
        voices = vr?.success ? (vr.data?.voices ?? []) : [];
      }
      setPiper({ ready, voices });
      // (Neural-not-installed is handled by the player's onError fallback — no
      // auto-switch here, which used to race the host-engine sync above.)
    }).catch(() => setPiper({ ready: false, voices: [] }));

    const p = new ReaderPlayer(settings.engine, settings.voice, settings.rate, {
      onSentence: (i) => { setActiveSentence(i); setActiveWord(null); live.current.onProgress(i); },
      onWord: (_, s, e) => setActiveWord({ start: s, end: e }),
      onState: (s) => { setPlayerState(s); if (s === 'playing') setEverPlayed(true); },
      onEnd: () => { setActiveWord(null); live.current.notify('ok', 'Finished — the whole book was read.'); },
      onError: (msg) => {
        if (live.current.engine !== 'browser') {
          live.current.notify('info', 'Neural voice unavailable — switching to the system voice.');
          live.current.onChange({ engine: 'browser' });
        } else {
          live.current.notify('err', msg);
        }
      },
    });
    p.load(sentences);
    p.seek(Math.min(book.progressSentence, Math.max(0, count - 1))); // reposition without autoplay
    playerRef.current = p;
    return () => { p.dispose(); playerRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply rate changes.
  useEffect(() => { playerRef.current?.setRate(settings.rate); }, [settings.rate]);
  // Apply engine / (language-matched) voice changes.
  useEffect(() => { playerRef.current?.setVoice(settings.engine, effectiveVoice); }, [settings.engine, effectiveVoice]);
  // Warm a neural engine ahead of first play (XTTS cold start ~30s) so the loading
  // state has something to show and playback starts sooner.
  useEffect(() => {
    if (settings.engine === 'piper' || settings.engine === 'xtts') bridge.ttsWarm(settings.engine).catch(() => { /* best-effort */ });
  }, [settings.engine]);

  // Sleep timer: arm a one-shot pause + a display countdown.
  useEffect(() => {
    if (settings.sleepMinutes <= 0) { setSleepRemaining(null); return; }
    const deadline = Date.now() + settings.sleepMinutes * 60_000;
    setSleepRemaining(settings.sleepMinutes);
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 60_000));
      setSleepRemaining(left);
      if (Date.now() >= deadline) {
        playerRef.current?.pause();
        notify('info', 'Sleep timer — playback paused. Good night.');
        onChange({ sleepMinutes: 0 });
      }
    }, 5_000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.sleepMinutes]);

  // Auto-scroll the active sentence into view.
  useEffect(() => {
    sentenceElRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeSentence]);

  // ── transport handlers ──────────────────────────────────────────────────────
  const seek = (i: number) => playerRef.current?.seek(Math.max(0, Math.min(i, count - 1)));
  const onToggle = () => playerRef.current?.toggle();
  const onSkip = (d: number) => seek(activeSentence + d);
  const onPrevChapter = () => {
    if (activeSentence > (chapter?.sentenceStart ?? 0) + 1) seek(chapter.sentenceStart);
    else if (activeChapter > 0) seek(book.chapters[activeChapter - 1].sentenceStart);
    else seek(0);
  };
  const onNextChapter = () => {
    if (activeChapter + 1 < book.chapters.length) seek(book.chapters[activeChapter + 1].sentenceStart);
  };

  // A voice pick in the dock becomes the manual override (wins over language match).
  const dockChange = (patch: Partial<ReaderSettings>) => {
    const picksVoice = patch.engine !== undefined || patch.voice !== undefined;
    if (patch.voice !== undefined) setManualVoice(patch.voice);
    onChange(picksVoice ? { ...patch, voiceOverridden: true } : patch);
  };

  // ── prose (only the current chapter is materialized, for performance) ────────
  const renderSentence = (i: number) => {
    const text = sentences[i];
    if (i === activeSentence && activeWord) {
      const before = text.slice(0, activeWord.start);
      const word = text.slice(activeWord.start, activeWord.end);
      const after = text.slice(activeWord.end);
      return (
        <span key={i} ref={sentenceElRef} className="sentence active">
          {before}<span className="kw">{word}</span>{after}{' '}
        </span>
      );
    }
    if (i === activeSentence) return <span key={i} ref={sentenceElRef} className="sentence active">{text}{' '}</span>;
    return <span key={i} className="sentence">{text}{' '}</span>;
  };

  // Group the chapter's sentences into paragraphs — a blank line in the source
  // between two sentences starts a new one — so the page reads like a book, not a wall.
  const proseStart = chapter?.sentenceStart ?? 0;
  const paragraphs: number[][] = [];
  let curPara: number[] = [];
  for (let i = proseStart; i < chapterEndSentence; i++) {
    const off = loaded.sentenceOffsets[i];
    const prevOff = i > proseStart ? loaded.sentenceOffsets[i - 1] : undefined;
    const startsPara = curPara.length > 0 && off !== undefined && prevOff !== undefined
      && loaded.text.lastIndexOf('\n\n', off) > prevOff;
    if (startsPara) { paragraphs.push(curPara); curPara = []; }
    curPara.push(i);
  }
  if (curPara.length) paragraphs.push(curPara);

  return (
    <div className="reader">
      <ChapterRail book={book} activeChapter={activeChapter} onJump={(ci) => seek(book.chapters[ci].sentenceStart)} />

      <div className="canvas-wrap" style={{ position: 'relative' }}>
        {playerState === 'buffering' && !everPlayed && (
          <div className="voice-loading">
            <div className="voice-loading-card">
              <svg className="inf-loader" viewBox="0 0 24 24" width="60" height="34" aria-hidden="true">
                <path className="inf-bg" d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z" />
                <path className="inf-trace" pathLength={100} d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4Zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4Z" />
              </svg>
              <span>Preparing the voice…</span>
            </div>
          </div>
        )}
        <div className="topbar" style={{ borderBottom: '1px solid var(--stroke-soft)' }}>
          <button className="btn btn-ghost" onClick={onBack} style={{ transform: 'scaleX(-1)' }} title="Back to library">
            <IconChevron size={18} />
          </button>
          <div style={{ minWidth: 0 }}>
            <div className="dock-now-ch" style={{ fontSize: 14 }}>{chapter?.title || book.title}</div>
            <div className="brand-sub">Chapter {activeChapter + 1} of {book.chapters.length}</div>
          </div>
          <div className="topbar-spacer" />
          {canCompare && (
            <button className={`chip ${compare ? 'on' : ''}`} onClick={() => setCompare(v => !v)} title="Compare with the original PDF">
              <IconColumns size={15} /> PDF
            </button>
          )}
          {canCompare && (
            <button className="chip" onClick={onDeepOcr} title="Re-OCR every page properly (slow, higher quality than an embedded text layer)">
              <IconSparkle size={15} /> Deep OCR
            </button>
          )}
          <button className="chip" onClick={() => onChange({ fontSize: Math.max(15, settings.fontSize - 2) })}>A−</button>
          <button className="chip" onClick={() => onChange({ fontSize: Math.min(30, settings.fontSize + 2) })}>A+</button>
          <button className="chip" onClick={() => {
            const order: ReaderSettings['theme'][] = ['night', 'sepia', 'paper'];
            onChange({ theme: order[(order.indexOf(settings.theme) + 1) % order.length] });
          }}>{settings.theme}</button>
        </div>

        <div className="reader-body">
          <div className={`canvas theme-${settings.theme}`} style={{ ['--reader-fs' as string]: `${settings.fontSize}px` }}>
            <div className="prose">
              {paragraphs.map((para, pi) => <p key={pi} className="para">{para.map(renderSentence)}</p>)}
            </div>
          </div>
          {compare && canCompare && <PdfCompare filePath={book.filePath} onClose={() => setCompare(false)} />}
        </div>
      </div>

      <AudioDock
        state={playerState}
        chapterTitle={chapter?.title || book.title}
        sentenceIndex={activeSentence}
        sentenceCount={count}
        pct={count > 1 ? activeSentence / (count - 1) : 0}
        ticks={ticks}
        settings={settings}
        sleepRemaining={sleepRemaining}
        onToggle={onToggle}
        onPrevChapter={onPrevChapter}
        onNextChapter={onNextChapter}
        onSkip={onSkip}
        onSeekPct={(p) => seek(Math.round(p * (count - 1)))}
        onChange={dockChange}
      />
    </div>
  );
}
