/**
 * VoiceEngine — the reader's playback core. Two interchangeable backends behind
 * one Player API:
 *
 *   • 'browser' — Web Speech API (speechSynthesis). Emits real word-boundary
 *     events, so karaoke highlighting is exact. Always available in Chromium.
 *   • 'piper'   — the host's local neural TTS. Higher quality; returns raw PCM
 *     we play via Web Audio with prefetch for gapless sentence-to-sentence
 *     playback. Karaoke is time-interpolated across the sentence's words.
 *
 * A generation counter invalidates in-flight callbacks whenever we stop, seek,
 * or switch engine, so a late onended/onboundary can never advance stale state.
 */
import { bridge } from './bridge';

export type PlayerState = 'idle' | 'playing' | 'paused' | 'buffering';

export interface PlayerHooks {
  /** Fired when a sentence starts. */
  onSentence?: (index: number) => void;
  /** Karaoke: the active word's char range *within* sentence `index`. */
  onWord?: (index: number, charStart: number, charEnd: number) => void;
  onState?: (state: PlayerState) => void;
  /** Reached the end of the book. */
  onEnd?: () => void;
  onError?: (message: string) => void;
}

export interface BrowserVoiceInfo { id: string; name: string; lang: string }

/** List installed browser (SAPI/system) voices. May be empty until the engine warms up. */
export function listBrowserVoices(): BrowserVoiceInfo[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis.getVoices().map(v => ({ id: v.voiceURI, name: v.name, lang: v.lang }));
}

/** Resolve once the browser voice list is populated (Chromium loads it async). */
export function warmBrowserVoices(): Promise<BrowserVoiceInfo[]> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') return resolve([]);
    const now = listBrowserVoices();
    if (now.length) return resolve(now);
    const handler = () => { speechSynthesis.onvoiceschanged = null; resolve(listBrowserVoices()); };
    speechSynthesis.onvoiceschanged = handler;
    // Fallback if the event never fires.
    setTimeout(() => resolve(listBrowserVoices()), 800);
  });
}

interface WordSpan { start: number; end: number }
function tokenizeWords(s: string): WordSpan[] {
  const out: WordSpan[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

/**
 * Read-ahead depth: how many upcoming sentences to synthesize in advance so
 * playback + the karaoke follow-along stay buffered. A reader-side parameter —
 * it does NOT change the host TTS engine. Bigger = smoother start and more time
 * to load the text-tracking; costs a little memory/CPU up front.
 */
const PREFETCH_LEAD = 3;

/** Schedule up to this many seconds of audio ahead on the Web Audio clock (gapless). */
const LOOKAHEAD_SEC = 12;

/** Give up on a stuck synthesis after this long — a hung request must never freeze reading. */
const TTS_TIMEOUT_MS = 15_000;

/** Reject if a promise doesn't settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TTS_TIMEOUT')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class ReaderPlayer {
  private sentences: string[] = [];
  private index = 0;
  private gen = 0;
  private _state: PlayerState = 'idle';

  private engine: 'browser' | 'piper' | 'xtts';
  private voice: string;
  private rate: number;
  private hooks: PlayerHooks;

  // Host (piper) backend state.
  private audioCtx: AudioContext | null = null;
  private bufferCache = new Map<number, AudioBuffer>();
  private pending = new Map<number, Promise<AudioBuffer | null>>(); // in-flight fetches (dedup)
  private rafId = 0; // gapless-scheduler tracker rAF
  private keepAlive: ReturnType<typeof setInterval> | null = null; // Chromium speechSynthesis keep-alive
  // Gapless scheduler: neural chunks queued on the Web Audio clock, back-to-back.
  private scheduled: Array<{ index: number; startAt: number; endAt: number; src: AudioBufferSourceNode }> = [];
  private schedNext = 0;    // next unit index to schedule
  private schedNextAt = 0;  // ctx-clock time for the next chunk (0 = start ~now)
  private pumping = false;  // guard against concurrent schedule pumps
  private lastAudible = -1; // currently-audible unit (drives onSentence)
  private curWords: WordSpan[] = []; // tokenized words of the audible unit (karaoke)

  constructor(engine: 'browser' | 'piper' | 'xtts', voice: string, rate: number, hooks: PlayerHooks) {
    this.engine = engine;
    this.voice = voice;
    this.rate = rate;
    this.hooks = hooks;
  }

  get state(): PlayerState { return this._state; }
  get currentIndex(): number { return this.index; }

  private setState(s: PlayerState) { this._state = s; this.hooks.onState?.(s); }

  load(sentences: string[]) {
    this.stop();
    this.sentences = sentences;
    this.index = 0;
  }

  /** Play from a sentence index (defaults to the current position). */
  play(from?: number) {
    if (!this.sentences.length) return;
    if (typeof from === 'number') this.index = Math.max(0, Math.min(from, this.sentences.length - 1));
    this.gen++;
    this.setState('playing');
    if (this.engine === 'browser') this.speakBrowser();
    else void this.startPiper();
  }

  pause() {
    if (this._state !== 'playing') return;
    if (this.engine === 'browser') { try { speechSynthesis.pause(); } catch { /* noop */ } }
    else { void this.audioCtx?.suspend(); this.cancelRaf(); }
    this.setState('paused');
  }

  resume() {
    if (this._state !== 'paused') return;
    if (this.engine === 'browser') { try { speechSynthesis.resume(); } catch { /* noop */ } this.setState('playing'); }
    else { void this.audioCtx?.resume().then(() => this.startPiperTracker(this.gen)); this.setState('playing'); }
  }

  toggle() { if (this._state === 'playing') this.pause(); else if (this._state === 'paused') this.resume(); else this.play(); }

  /** Jump to a sentence; keeps playing if we were playing, else just repositions. */
  seek(index: number) {
    const wasPlaying = this._state === 'playing' || this._state === 'buffering';
    this.stopAudioOnly();
    this.index = Math.max(0, Math.min(index, this.sentences.length - 1));
    this.hooks.onSentence?.(this.index);
    if (wasPlaying) this.play(this.index);
  }

  stop() {
    this.stopAudioOnly();
    this.setState('idle');
  }

  setRate(rate: number) {
    this.rate = rate;
    // Piper bakes speed into synthesis, so cached + in-flight buffers are now wrong.
    if (this.engine === 'piper') { this.bufferCache.clear(); this.pending.clear(); }
    if (this._state === 'playing') this.seek(this.index); // restart current sentence at new rate
  }

  setVoice(engine: 'browser' | 'piper' | 'xtts', voice: string) {
    const wasPlaying = this._state === 'playing';
    this.stopAudioOnly();
    this.engine = engine;
    this.voice = voice;
    this.bufferCache.clear();
    this.pending.clear();
    if (wasPlaying) this.play(this.index);
  }

  dispose() {
    this.stopAudioOnly();
    if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
    if (this.audioCtx) { void this.audioCtx.close(); this.audioCtx = null; }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private cancelRaf() { if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; } }

  private stopAudioOnly() {
    this.gen++;
    this.cancelRaf();
    if (this.engine === 'browser') { try { speechSynthesis.cancel(); } catch { /* noop */ } }
    for (const c of this.scheduled) { try { c.src.onended = null; c.src.stop(); } catch { /* already stopped */ } }
    this.scheduled = [];
    this.schedNext = 0; this.schedNextAt = 0; this.lastAudible = -1; this.pumping = false;
  }

  private advance(gen: number) {
    if (gen !== this.gen) return;
    if (this.index + 1 >= this.sentences.length) { this.setState('idle'); this.hooks.onEnd?.(); return; }
    this.index++;
    if (this.engine === 'browser') this.speakBrowser();
    else void this.startPiper();
  }

  // ── browser (Web Speech) ──────────────────────────────────────────────────

  private speakBrowser() {
    if (typeof speechSynthesis === 'undefined') { this.hooks.onError?.('Web Speech unavailable'); this.setState('idle'); return; }
    const gen = this.gen;
    const i = this.index;
    const text = this.sentences[i];
    this.hooks.onSentence?.(i);

    const u = new SpeechSynthesisUtterance(text);
    u.rate = Math.max(0.5, Math.min(2, this.rate));
    const match = speechSynthesis.getVoices().find(v => v.voiceURI === this.voice || v.name === this.voice);
    if (match) u.voice = match;

    u.onboundary = (e: SpeechSynthesisEvent) => {
      if (gen !== this.gen) return;
      if (e.name && e.name !== 'word') return;
      const start = e.charIndex ?? 0;
      // charLength is not always present; approximate to the next whitespace.
      let end = start + (e.charLength ?? 0);
      if (!e.charLength) { const nxt = text.indexOf(' ', start); end = nxt === -1 ? text.length : nxt; }
      this.hooks.onWord?.(i, start, end);
    };
    // Chromium cuts long/idle utterances (~15s) and can drop the 'end' event —
    // a keep-alive prevents the freeze; a watchdog force-advances if 'end' never
    // fires, so reading never stalls silently on the system voice.
    this.startKeepAlive();
    const watchdog = setTimeout(() => {
      if (gen === this.gen && this._state === 'playing') this.advance(gen);
    }, (text.length * 100) / u.rate + 6000);
    u.onend = () => { clearTimeout(watchdog); this.advance(gen); };
    u.onerror = (ev: SpeechSynthesisErrorEvent) => {
      clearTimeout(watchdog);
      if (gen !== this.gen) return;
      if (ev.error === 'interrupted' || ev.error === 'canceled') return; // our own stop/seek
      this.hooks.onError?.(`Speech error: ${ev.error}`);
      this.advance(gen);
    };
    try { speechSynthesis.speak(u); } catch (err) { clearTimeout(watchdog); this.hooks.onError?.(String(err)); }
  }

  /** Keep Chromium's speechSynthesis from auto-pausing during long browser playback. */
  private startKeepAlive() {
    if (this.keepAlive) return;
    this.keepAlive = setInterval(() => {
      if (this._state === 'playing' && this.engine === 'browser') {
        try { speechSynthesis.pause(); speechSynthesis.resume(); } catch { /* noop */ }
      }
    }, 12_000);
    (this.keepAlive as unknown as { unref?: () => void }).unref?.();
  }

  // ── host Piper (Web Audio) ────────────────────────────────────────────────

  private ensureCtx(): AudioContext {
    if (!this.audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctor();
    }
    return this.audioCtx;
  }

  private decodePcm(base64: string, sampleRate: number): AudioBuffer {
    const bin = atob(base64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const view = new DataView(bytes.buffer);
    const samples = Math.floor(len / 2);
    const ctx = this.ensureCtx();
    const buf = ctx.createBuffer(1, samples, sampleRate || 22050);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    return buf;
  }

  private fetchBuffer(i: number): Promise<AudioBuffer | null> {
    if (i < 0 || i >= this.sentences.length) return Promise.resolve(null);
    const cached = this.bufferCache.get(i);
    if (cached) return Promise.resolve(cached);
    const existing = this.pending.get(i);
    if (existing) return existing; // dedup: prefetch + playback share one request
    const job = (async () => {
      const res = await withTimeout(
        bridge.ttsSpeak(this.sentences[i], this.voice, this.rate, this.engine === 'xtts' ? 'xtts' : 'piper'),
        TTS_TIMEOUT_MS,
      );
      if (!res?.success || !res.pcmBase64) throw new Error(res?.error || 'TTS_FAILED');
      const buf = this.decodePcm(res.pcmBase64, res.sampleRate ?? 22050);
      this.bufferCache.set(i, buf);
      // Bound the cache so a long book doesn't grow unbounded.
      if (this.bufferCache.size > PREFETCH_LEAD + 4) {
        const oldest = [...this.bufferCache.keys()].find(k => k < i - 1);
        if (oldest !== undefined) this.bufferCache.delete(oldest);
      }
      return buf;
    })();
    this.pending.set(i, job);
    job.then(() => this.pending.delete(i), () => this.pending.delete(i));
    return job;
  }

  private consecFail = 0;   // consecutive synth failures → fall back after a few

  /** Start gapless neural playback from this.index: schedule chunks on the audio clock. */
  private async startPiper() {
    const gen = this.gen;
    const ctx = this.ensureCtx();
    try { if (ctx.state === 'suspended') await ctx.resume(); } catch { /* noop */ }
    if (gen !== this.gen) return;
    this.schedNext = this.index;
    this.schedNextAt = 0;
    this.lastAudible = -1;
    if (!this.bufferCache.has(this.index)) this.setState('buffering');
    this.startPiperTracker(gen);
    void this.pumpSchedule(gen);
  }

  /**
   * Fill the schedule up to ~LOOKAHEAD_SEC of audio ahead, back-to-back on the
   * audio clock (so chunks play gaplessly). Fetches one unit at a time (retry once,
   * skip on repeated failure). Re-invoked by the tracker as playback advances.
   */
  private async pumpSchedule(gen: number) {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const ctx = this.ensureCtx();
      while (gen === this.gen && this.schedNext < this.sentences.length) {
        const queuedUntil = this.schedNextAt || ctx.currentTime;
        if (queuedUntil > ctx.currentTime + LOOKAHEAD_SEC) break; // enough buffered ahead
        const idx = this.schedNext;
        let buf: AudioBuffer | null = null;
        for (let attempt = 0; attempt < 2 && buf === null; attempt++) {
          try { buf = await this.fetchBuffer(idx); }
          catch (err) {
            if (gen !== this.gen) return;
            if (attempt === 0) { this.pending.delete(idx); continue; }
            console.warn('[voice] chunk failed, skipping', idx, err instanceof Error ? err.message : err);
            if (++this.consecFail >= 3) { this.consecFail = 0; this.hooks.onError?.(err instanceof Error ? err.message : String(err)); return; }
            break; // skip this unit
          }
        }
        if (gen !== this.gen) return;
        this.schedNext = idx + 1;
        if (!buf) continue; // skipped
        this.consecFail = 0;
        // Never schedule in the past: if synthesis fell behind playback, start the next
        // chunk just ahead of 'now' (small gap) instead of stacking sources (overlap/garble).
        const startAt = this.schedNextAt === 0
          ? ctx.currentTime + 0.08
          : Math.max(this.schedNextAt, ctx.currentTime + 0.02);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        try { src.start(startAt); } catch { continue; }
        this.scheduled.push({ index: idx, startAt, endAt: startAt + buf.duration, src });
        this.schedNextAt = startAt + buf.duration;
      }
    } finally {
      this.pumping = false;
    }
  }

  /** rAF loop: map the audio clock → audible unit (onSentence) + word (onWord), keep the
   *  schedule topped up, and detect end. Absolute scheduling means pause = ctx.suspend(). */
  private startPiperTracker(gen: number) {
    this.cancelRaf();
    const ctx = this.ensureCtx();
    const tick = () => {
      if (gen !== this.gen) return;
      const t = ctx.currentTime;
      // Once any audio is queued we're no longer buffering — don't hang on
      // "Synthesizing…" if the clock sits a hair outside a chunk's window.
      if (this.scheduled.length && this._state === 'buffering') this.setState('playing');
      const cur = this.scheduled.find(c => t >= c.startAt && t < c.endAt);
      if (cur) {
        if (this._state !== 'playing') this.setState('playing');
        if (cur.index !== this.lastAudible) {
          this.lastAudible = cur.index;
          this.index = cur.index;
          this.curWords = tokenizeWords(this.sentences[cur.index]);
          this.hooks.onSentence?.(cur.index);
        }
        if (this.curWords.length) {
          const frac = Math.min(1, (t - cur.startAt) / Math.max(0.001, cur.endAt - cur.startAt));
          const weights = this.curWords.map(w => w.end - w.start + 1);
          const totalW = weights.reduce((a, b) => a + b, 0);
          const targetW = frac * totalW;
          let acc = 0, wi = 0;
          for (; wi < weights.length; wi++) { acc += weights[wi]; if (acc >= targetW) break; }
          const w = this.curWords[Math.min(wi, this.curWords.length - 1)];
          this.hooks.onWord?.(cur.index, w.start, w.end);
        }
      }
      this.scheduled = this.scheduled.filter(c => c.endAt > t - 0.5); // prune finished
      if (this.schedNext >= this.sentences.length && this.scheduled.every(c => c.endAt <= t)) {
        this.setState('idle'); this.hooks.onEnd?.(); return;
      }
      void this.pumpSchedule(gen); // top up as playback advances
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }
}
