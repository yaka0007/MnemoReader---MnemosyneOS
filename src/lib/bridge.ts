/**
 * The single channel between MnemoReader and Mnemosyne OS.
 * Everything host-side goes through the postMessage SDK — actions are
 * whitelisted by the host actionRegistry. When run outside the host shell
 * (standalone `pnpm dev` in a browser tab), `isFramed()` is false and the
 * caller should fall back to browser-only features (Web Speech, file input).
 */
import { MnemoCartridgeSDK } from '../sdk/mnemo-sdk';

const PLUGIN_ID = '@mnemosyne-plugins/mnemo-reader';
const sdk = new MnemoCartridgeSDK(PLUGIN_ID);

// Per-action reply timeouts. Defaults to the SDK's 30 s; long-running host work
// gets explicit headroom above its own host-side ceiling, and user-paced OS
// dialogs get NO timeout (0) — a picker left open must never reject.
const NO_TIMEOUT = 0;
const EXTRACT_TIMEOUT_MS = 25 * 60_000; // host deep-OCR ceiling is 20 min
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // up to 200 MB on a slow link
const RENDER_TIMEOUT_MS = 90_000; // host render timeout is 60 s
const TTS_WARM_TIMEOUT_MS = 180_000; // XTTS sidecar spawn + model load
const TTS_SPEAK_TIMEOUT_MS = 60_000; // playback gives up sooner; this just settles the promise

/** True when running inside the host shell (an iframe with a distinct parent). */
export function isFramed(): boolean {
  try { return typeof window !== 'undefined' && window.parent !== window.self; }
  catch { return true; }
}

export interface ExtractedDocument {
  name: string; ext: string; text: string; truncated: boolean;
  /** Chapter markers from a structured source (EPUB TOC) — char offsets into `text`. */
  chapters?: { title: string; offset: number }[];
}
export interface DirEntry { name: string; isDirectory: boolean; path: string }

export const bridge = {
  /** Open the OS file picker for a supported document. Returns an absolute path or null. */
  selectFile: (extensions: string[]) =>
    sdk.invoke<string | null>('dialog.selectFile', { filters: [{ name: 'Documents', extensions }] }, NO_TIMEOUT),

  /** Open the OS folder picker. Returns an absolute path or null. */
  selectFolder: () => sdk.invoke<string | null>('dialog.selectFolder', undefined, NO_TIMEOUT),

  /** List a directory (host side) — used to discover PDFs inside a chosen folder. */
  readDir: (dirPath: string) =>
    sdk.invoke<{ success: boolean; files?: DirEntry[]; error?: string }>('dialog.readDir', { dirPath }),

  /** Extract plain text from a PDF/DOCX/text file on disk (host uses pdf-parse/mammoth).
   *  `forceOcr` re-runs a proper OCR pass instead of trusting a poor embedded text layer. */
  extractDocument: (filePath: string, forceOcr = false) =>
    sdk.invoke<{ success: boolean; data?: ExtractedDocument; error?: string }>('reader.extractDocument', { filePath, forceOcr }, EXTRACT_TIMEOUT_MS),

  /** Download a remote document (PDF/EPUB/…) to a local file host-side. Returns its path. */
  downloadUrl: (url: string) =>
    sdk.invoke<{ success: boolean; data?: { path: string; name: string; bytes: number }; error?: string }>('reader.downloadUrl', { url }, DOWNLOAD_TIMEOUT_MS),

  /** Render one PDF page to a JPEG (base64) — for the side-by-side compare view. */
  renderPage: (filePath: string, page: number) =>
    sdk.invoke<{ success: boolean; data?: { image: string; pages: number; w: number; h: number }; error?: string }>('reader.renderPage', { filePath, page }, RENDER_TIMEOUT_MS),

  /** The user's configured voice from the host Settings → Voice (engine/voice/speed). */
  voiceConfig: () =>
    sdk.invoke<{ engine: 'browser' | 'piper' | 'xtts'; voice: string; speed: number }>('reader.voiceConfig'),

  /** Whether a local neural voice engine (piper | xtts) is ready (installed + licensed). */
  ttsStatus: (engine: 'piper' | 'xtts' = 'piper') =>
    sdk.invoke<{ success: boolean; data?: { ready: boolean }; error?: string }>('reader.ttsStatus', { engine }),

  /** Installed Piper voice ids. */
  ttsVoices: () =>
    sdk.invoke<{ success: boolean; data?: { voices: string[] }; error?: string }>('reader.ttsVoices'),

  /** Preload a neural engine (sidecar spawn + model load) before first synthesis. */
  ttsWarm: (engine: 'piper' | 'xtts' = 'piper') =>
    sdk.invoke<{ success: boolean; error?: string }>('reader.ttsWarm', { engine }, TTS_WARM_TIMEOUT_MS),

  /** Synthesize one chunk of text → raw PCM (base64) the renderer plays via Web Audio. */
  ttsSpeak: (text: string, voice: string, speed: number, engine: 'piper' | 'xtts' = 'piper') =>
    sdk.invoke<{ success: boolean; pcmBase64?: string; sampleRate?: number; error?: string }>(
      'reader.ttsSpeak', { text, voice, speed, engine }, TTS_SPEAK_TIMEOUT_MS
    ),

  /** Host + vault status — used to detect whether the Library vault already exists. */
  status: () =>
    sdk.invoke<{ vaults?: { displayName?: string; state?: string; chronicleCount?: number }[] }>('mnemosyne.status'),

  /** Workspace config; `rootPath` is the parent dir for a new top-level vault. */
  getConfig: () => sdk.invoke<{ rootPath?: string } | null>('vault.getConfig'),

  /** Create a (sub-)vault. Used to provision the Library vault on first import. */
  createVault: (opts: { parentDir: string; displayName: string; type?: string; color?: string; icon?: string; parentId?: string | null; description?: string }) =>
    sdk.invoke<{ success: boolean; manifest?: { path?: string; id?: string }; error?: string }>('vault.create', opts),

  /** Vectorize + archive one chunk of book text into the Library vault (SHA-256 dedup, host side). */
  // `sourceRef` (the book id) tags every archived chunk so a future host-gated
  // "forget this book's memory" flow can target them.
  ingest: (vault: string, content: string, sourceRef?: string) =>
    sdk.invoke<{ chronicleId?: string }>('reader.ingest', { vault, content, ...(sourceRef ? { sourceRef } : {}) }),

  // ── App sandbox vault (doc 58) ───────────────────────────────────────────
  // A walled-off `APP-MNEMO-READER` vault holds one SOCIAL_CONTACT chronicle
  // per book so the Vault Pad tile shows an exact book count. This is separate
  // from the full-text LIBRARY archive above (different vault, no collision):
  // LIBRARY holds the searchable chunked text; the sandbox holds the catalogue.

  /** Idempotently create+mount this app's own walled-off sandbox vault. */
  ensureSandbox: () => sdk.ensureSandbox(),

  /** Declare how the host renders this app's Vault Pad tile (icon + spine metrics). */
  describeVaultTile: (tile: { icon?: string; metrics?: { label: string; spine?: string }[] }) =>
    sdk.describeVaultTile(tile),

  /** Anchor one chronicle into a NAMED vault (used for the per-book catalogue). */
  socialIngest: (vault: string, content: string, spineType?: string) =>
    sdk.socialIngest(vault, content, spineType),

  /** Open a URL in the OS browser. Best-effort. */
  openExternal: (url: string) => sdk.invoke('shell.openExternal', { url }).catch(() => {}),
};
