// storage.js — persistence with a graceful in-memory fallback for private mode
// / disabled storage. No network access; everything stays on the device.

const memoryStore = new Map();

export const storage = {
  getItem(key) {
    try { return window.localStorage.getItem(key); }
    catch { return memoryStore.has(key) ? memoryStore.get(key) : null; }
  },
  setItem(key, value) {
    try { window.localStorage.setItem(key, String(value)); }
    catch { memoryStore.set(key, String(value)); }
  },
  removeItem(key) {
    try { window.localStorage.removeItem(key); }
    catch { memoryStore.delete(key); }
  }
};

export function loadJson(key, fallback) {
  try {
    const value = JSON.parse(storage.getItem(key));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key, value) {
  storage.setItem(key, JSON.stringify(value));
}

// Trigger a client-side download of an object as pretty JSON (used for the
// diagnostic event export). Returns false if the environment can't download.
export function downloadJson(filename, data) {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}
