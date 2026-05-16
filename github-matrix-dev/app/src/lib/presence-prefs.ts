/**
 * Live-presence configuration.
 *
 * Presence is not optional: peers are always shown and in-app location is
 * always shared. The hook exposes a fixed, always-on preference object so
 * existing call sites keep working without a per-browser toggle.
 */

export interface PresencePrefs {
  /** Render other users' presence (avatars, location dots) at all. */
  showPeers: boolean;
  /** Broadcast my own in-app location to peers. */
  shareLocation: boolean;
}

const PREFS: PresencePrefs = {
  showPeers: true,
  shareLocation: true,
};

/** React hook: returns the always-on presence preferences. */
export function usePresencePrefs(): [PresencePrefs] {
  return [PREFS];
}
