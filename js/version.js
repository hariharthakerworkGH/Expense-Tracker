// The app's version, and a way to notice when you're looking at an old one.
//
// Because the service worker serves from cache first, the load straight after
// a deploy shows you the PREVIOUS version - the new files are fetched in the
// background and only take effect on the next open. That has caused real
// confusion: a feature that was removed still appears, and it looks like the
// change never happened. So the app now compares the version it is actually
// running against the newest version sitting in the cache, and says so.
//
// IMPORTANT: bump APP_VERSION and CACHE_NAME in sw.js together. They are
// compared at runtime, and a mismatch is what drives the banner below.
export const APP_VERSION = 24;
export const BUILD_DATE = '2026-09-14';

// What's running versus what's downloaded and waiting.
export async function versionStatus() {
  let cached = null;
  try {
    const keys = await caches.keys();
    const versions = keys
      .map((k) => Number((k.match(/v(\d+)$/) || [])[1]))
      .filter((n) => Number.isFinite(n));
    if (versions.length) cached = Math.max(...versions);
  } catch {
    // Cache Storage can be unavailable (private windows, blocked site data).
    // Not knowing is fine - it just means no staleness claim either way.
  }
  return {
    running: APP_VERSION,
    cached,
    stale: cached != null && cached > APP_VERSION,
  };
}

// Ask the browser to look for a new service worker right now, rather than
// waiting for it to check on its own schedule.
export async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return { running: APP_VERSION, cached: null, stale: false };
  const reg = await navigator.serviceWorker.getRegistration().catch(() => null);
  if (reg) {
    try {
      await reg.update();
    } catch {
      // Offline, or the server is unreachable. The cached version is still
      // perfectly usable, so there is nothing to report.
    }
    // The new worker installs and caches its files asynchronously; give it a
    // moment before reading the cache list back.
    await new Promise((r) => setTimeout(r, 1500));
  }
  return versionStatus();
}
