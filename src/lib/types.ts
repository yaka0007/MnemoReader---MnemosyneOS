/** Shared domain types for MnemoReader. */

/** A detected chapter within a book. `start`/`end` are character offsets into the full text. */
export interface Chapter {
  id: string;
  title: string;
  /** Character offset of the chapter's first content character. */
  start: number;
  /** Character offset just past the chapter's last character. */
  end: number;
  /** Index of the first sentence belonging to this chapter. */
  sentenceStart: number;
}

/** Ingest / vectorization lifecycle of a book. */
export type IngestState = 'idle' | 'extracting' | 'chaptering' | 'vectorizing' | 'archived' | 'error';

/** A book in the library. Heavy `text`/`sentences` live only in the open reader, not in persisted metadata. */
export interface Book {
  id: string;
  title: string;
  author?: string;
  /** Absolute path on disk (host side). Kept so we can re-extract on open. */
  filePath: string;
  ext: string;
  /** Accent hue (0-360) derived from the title — drives the generated cover. */
  hue: number;
  addedAt: number;
  /** Total sentence count (for progress math). */
  sentenceCount: number;
  chapters: Chapter[];
  /** 0-based index of the last sentence the user reached. */
  progressSentence: number;
  ingest: IngestState;
  ingestError?: string;
  /** True once vectorized into the Library vault. */
  archived: boolean;
  truncated?: boolean;
}

/** The full loaded content of an open book (not persisted). */
export interface LoadedBook {
  bookId: string;
  text: string;
  sentences: string[];
  /** Char offset of the first character of each sentence, parallel to `sentences`. */
  sentenceOffsets: number[];
}

export type VoiceEngineId = 'browser' | 'piper' | 'xtts';

export interface ReaderSettings {
  engine: VoiceEngineId;
  /** Host Piper voice id (e.g. "fr_FR-siwis-medium") or a browser voice URI. */
  voice: string;
  /** Playback rate multiplier (0.5 – 2). */
  rate: number;
  /** Reading font size in px. */
  fontSize: number;
  /** Sleep-timer minutes; 0 = off. */
  sleepMinutes: number;
  theme: 'night' | 'sepia' | 'paper';
  /** True once the user picked a voice/engine inside MnemoReader — stops auto-following the host. */
  voiceOverridden?: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
  engine: 'browser',
  voice: '',
  rate: 1,
  fontSize: 20,
  sleepMinutes: 0,
  theme: 'night',
  voiceOverridden: false,
};

/** Name of the vault MnemoReader archives books into. */
export const LIBRARY_VAULT = 'LIBRARY';
