import { bridge } from './bridge';
import { LIBRARY_VAULT } from './types';

let ensured = false;

/**
 * Best-effort: make sure the Library vault exists so book ingests have a home.
 * The host's ingest pipeline resolves a vault by name but won't create it, so we
 * provision it once per session. A no-op if it already exists or can't be created
 * (ingest is best-effort — reading works regardless).
 */
export async function ensureLibraryVault(): Promise<{ ok: boolean; error?: string }> {
  if (ensured) return { ok: true };
  try {
    const status = await bridge.status().catch(() => null);
    const exists = (status?.vaults ?? []).some(v => (v.displayName ?? '').toUpperCase() === LIBRARY_VAULT);
    if (exists) { ensured = true; return { ok: true }; }

    const cfg = await bridge.getConfig().catch(() => null);
    const rootPath = cfg?.rootPath;
    if (!rootPath) return { ok: false, error: 'NO_VAULT_ROOT' };

    const res = await bridge.createVault({
      parentDir: rootPath,
      displayName: LIBRARY_VAULT,
      type: 'library',
      color: '#f5b642',
      icon: 'book',
      description: 'MnemoReader — your vectorized PDF library',
      parentId: null,
    });
    ensured = !!res?.success;
    return { ok: ensured, error: res?.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
