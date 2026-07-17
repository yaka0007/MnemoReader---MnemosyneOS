import { useCallback, useEffect, useState } from 'react';

/** Persisted state hook — reads once, writes on change. Namespaced to avoid clashes. */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const storageKey = `mnemoreader.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(value)); }
    catch (err) { console.warn('[MnemoReader] persist failed', err); }
  }, [storageKey, value]);

  const set = useCallback((v: T | ((prev: T) => T)) => setValue(v), []);
  return [value, set];
}
