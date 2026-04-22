/**
 * Google Drive OAuth2 PKCE — browser-native authentication.
 *
 * No client secret is used. Tokens live in a module-scoped in-memory cache
 * (so they are never exposed to XSS via localStorage). For same-tab reloads
 * the access_token and expires_at are mirrored to sessionStorage; the
 * refresh_token is only held in memory and is discarded on tab close.
 *
 * Usage:
 *   1. Call initGoogleOAuth() once at app startup.
 *   2. Call startOAuthFlow() to authenticate. Resolves when tokens are stored.
 *   3. Call getAccessToken() anywhere to get a (auto-refreshed) Bearer token.
 */

// ──────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
// Scopes requested by the single PKCE flow. Drive (drive.file) + Calendar
// (calendar + calendar.events) are issued on one access token so both the
// gdrive-* and gcalendar-* modules share the same Bearer token.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

// Session keys. The access token and its expiry are mirrored to sessionStorage
// so a page reload in the same tab can resume without re-auth; the refresh
// token stays in memory only.
const SS_ACCESS_TOKEN = 'eo-gdrive-access-token';
const SS_EXPIRES_AT = 'eo-gdrive-expires-at';
const SS_CODE_VERIFIER = 'eo-gdrive-code-verifier';
const SS_PENDING_ROUTE = 'eo-gdrive-pending-route';
const SS_POPUP_RESOLVE = 'eo-gdrive-popup-pending';

interface CachedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

let _tokens: CachedTokens | null = null;

function readSessionTokens(): CachedTokens | null {
  try {
    const access = sessionStorage.getItem(SS_ACCESS_TOKEN);
    const expires = Number(sessionStorage.getItem(SS_EXPIRES_AT) ?? '0');
    if (access && expires > 0) {
      return { accessToken: access, refreshToken: null, expiresAt: expires };
    }
  } catch {
    /* private-mode sessionStorage can throw — fall through */
  }
  return null;
}

function getCachedTokens(): CachedTokens | null {
  if (_tokens) return _tokens;
  _tokens = readSessionTokens();
  return _tokens;
}

function writeTokens(tokens: CachedTokens): void {
  _tokens = tokens;
  try {
    sessionStorage.setItem(SS_ACCESS_TOKEN, tokens.accessToken);
    sessionStorage.setItem(SS_EXPIRES_AT, String(tokens.expiresAt));
  } catch {
    /* storage unavailable — in-memory cache still works for this tab */
  }
}

// BroadcastChannel used to signal OAuth completion from the popup back to the
// opener. Needed because COOP on Google's OAuth pages severs the browsing
// context group — once severed, `window.opener.postMessage` silently no-ops.
const OAUTH_BROADCAST_CHANNEL = 'eo-gdrive-oauth';

// ──────────────────────────────────────────────────────────────
// Module state
// ──────────────────────────────────────────────────────────────

let _clientId = '';
let _redirectUri = '';

/**
 * Initialise the OAuth module. Call once at app startup before anything else.
 *
 * @param clientId   Google OAuth2 client ID (VITE_GOOGLE_CLIENT_ID).
 * @param redirectUri The registered redirect URI — must exactly match what is
 *                   registered in Google Cloud Console.
 */
export function initGoogleOAuth(clientId: string, redirectUri: string): void {
  _clientId = clientId;
  _redirectUri = redirectUri;
}

/**
 * Returns true when the OAuth module has been initialised with a non-empty
 * client ID. Callers should use this to gate UI (disable sign-in buttons,
 * show a "not configured" banner) instead of attempting the flow and
 * catching the thrown error. `VITE_GOOGLE_CLIENT_ID` must be set at build
 * time for the deployed app to have a client ID.
 */
export function isGoogleOAuthConfigured(): boolean {
  return !!_clientId;
}

// ──────────────────────────────────────────────────────────────
// PKCE helpers
// ──────────────────────────────────────────────────────────────

function base64urlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeVerifier(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(96));
  return base64urlEncode(bytes.buffer);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(digest);
}

// ──────────────────────────────────────────────────────────────
// Auth URL
// ──────────────────────────────────────────────────────────────

async function buildAuthUrl(mode: 'popup' | 'redirect'): Promise<{ url: string; verifier: string }> {
  if (!_clientId) {
    throw new Error('Google OAuth is not configured for this deployment (VITE_GOOGLE_CLIENT_ID is unset). Use n8n Proxy mode or rebuild with a Google OAuth client ID.');
  }
  const verifier = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const params = new URLSearchParams({
    client_id: _clientId,
    redirect_uri: _redirectUri,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state: mode,
  });
  return { url: `${GOOGLE_AUTH_ENDPOINT}?${params}`, verifier };
}


// ──────────────────────────────────────────────────────────────
// Token exchange
// ──────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
}

async function exchangeCode(code: string, verifier: string): Promise<void> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: _clientId,
      redirect_uri: _redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const json: TokenResponse = await res.json();
  if (json.error || !json.access_token) {
    throw new Error(`Token exchange failed: ${json.error ?? 'no access_token'}`);
  }
  storeTokens(json);
}

async function refreshTokens(): Promise<void> {
  const cached = getCachedTokens();
  const refreshToken = cached?.refreshToken;
  if (!refreshToken) throw new Error('No refresh token — user must re-authenticate');
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: _clientId,
      grant_type: 'refresh_token',
    }),
  });
  const json: TokenResponse = await res.json();
  if (json.error || !json.access_token) {
    clearTokens();
    throw new Error(`Token refresh failed: ${json.error ?? 'no access_token'}`);
  }
  storeTokens({ ...json, refresh_token: json.refresh_token ?? refreshToken });
}

function storeTokens(tokens: TokenResponse): void {
  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  writeTokens({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? _tokens?.refreshToken ?? null,
    expiresAt,
  });
}

// ──────────────────────────────────────────────────────────────
// Public token API
// ──────────────────────────────────────────────────────────────

/** Returns true when there's a stored token that is not expired. */
export function isConnected(): boolean {
  const cached = getCachedTokens();
  if (!cached) return false;
  return Date.now() < cached.expiresAt - 60_000;
}

/**
 * Get a valid Google access token, refreshing automatically if needed.
 * Throws if no tokens are stored (user must call startOAuthFlow first).
 */
export async function getAccessToken(): Promise<string> {
  const cached = getCachedTokens();
  if (!cached) throw new Error('Not authenticated with Google Drive');
  if (Date.now() >= cached.expiresAt - 60_000) {
    await refreshTokens();
  }
  return (_tokens ?? cached).accessToken;
}

/** Clear all stored tokens (sign out of Google Drive). */
export function clearTokens(): void {
  _tokens = null;
  try {
    sessionStorage.removeItem(SS_ACCESS_TOKEN);
    sessionStorage.removeItem(SS_EXPIRES_AT);
  } catch {
    /* ignore */
  }
}

// ──────────────────────────────────────────────────────────────
// Callback handler — called on the redirect landing page
// ──────────────────────────────────────────────────────────────

/**
 * Handle the OAuth callback — exchange the `?code=` query param for tokens.
 *
 * Returns true if a code was found and exchanged successfully.
 * Should be called early in App startup when `location.search` contains `code=`.
 *
 * After exchange the `?code=...&state=...` query string is removed from the
 * URL via history.replaceState so the code cannot be replayed.
 */
export async function handleOAuthCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  // Verifier is stored in localStorage (not sessionStorage) so popup windows
  // on the same origin can read it — sessionStorage is not shared with popups.
  const verifier = localStorage.getItem(SS_CODE_VERIFIER);
  if (!verifier) {
    console.warn('[EO-DB] OAuth callback: no code_verifier in localStorage');
    return false;
  }

  try {
    await exchangeCode(code, verifier);
    localStorage.removeItem(SS_CODE_VERIFIER);

    // Broadcast completion (and the freshly-issued tokens) over
    // BroadcastChannel. This is the primary popup→opener signal because COOP
    // from accounts.google.com severs the browsing-context group, which nulls
    // out window.opener and makes cross-window postMessage unreliable.
    // BroadcastChannel is same-origin only, so transmitting the tokens on it
    // is equivalent to letting another same-origin tab read them; we no
    // longer persist them to localStorage.
    const cached = getCachedTokens();
    try {
      const channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
      channel.postMessage({
        type: 'eo-gdrive-oauth-success',
        tokens: cached
          ? {
              access_token: cached.accessToken,
              refresh_token: cached.refreshToken ?? undefined,
              expires_at: cached.expiresAt,
            }
          : null,
      });
      channel.close();
    } catch {
      /* BroadcastChannel unsupported — opener falls back to postMessage */
    }

    // Use state param to reliably detect popup vs redirect flow.
    // window.opener is cleared by many browsers after cross-origin navigation
    // so it is NOT a reliable signal — state survives the round-trip.
    const state = params.get('state');
    const isPopup = state === 'popup';

    if (isPopup) {
      // Best-effort notify opener via legacy postMessage in case the BC group
      // wasn't severed (e.g. user re-consenting while still on our origin).
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(
            {
              type: 'eo-gdrive-oauth-success',
              tokens: cached
                ? {
                    access_token: cached.accessToken,
                    refresh_token: cached.refreshToken ?? undefined,
                    expires_at: cached.expiresAt,
                  }
                : null,
            },
            window.location.origin,
          );
        } catch {
          /* cross-origin / COOP — ignore */
        }
      }
      // Try to self-close. Under Chrome COOP this may silently fail because
      // the "closeable by script" flag was reset when the BC group was severed
      // during the round-trip through accounts.google.com. When that happens
      // the caller (App.tsx popup placeholder) shows a "you may close this
      // window" hint so the user has an explicit action.
      try { window.close(); } catch { /* ignore */ }
      return true;
    }

    // Redirect flow: strip ?code= from URL, restore pending route
    const newUrl = window.location.pathname + (window.location.hash || '');
    window.history.replaceState({}, '', newUrl);

    const pendingRoute = sessionStorage.getItem(SS_PENDING_ROUTE);
    sessionStorage.removeItem(SS_PENDING_ROUTE);
    if (pendingRoute && pendingRoute !== window.location.hash) {
      window.location.hash = pendingRoute;
    }

    return true;
  } catch (e) {
    console.error('[EO-DB] OAuth callback failed:', e);
    return false;
  }
}

// ──────────────────────────────────────────────────────────────
// Main flow — popup with redirect fallback
// ──────────────────────────────────────────────────────────────

/**
 * Start the Google Drive OAuth2 PKCE flow.
 *
 * Tries a popup window first. If the popup is blocked by the browser,
 * falls back to a full-page redirect (and restores the current route on return).
 *
 * Resolves when tokens have been stored successfully.
 */
export async function startOAuthFlow(): Promise<void> {
  if (isConnected()) return;

  // Open the popup synchronously on the user-activation tick, BEFORE any
  // async await. buildAuthUrl() awaits crypto.subtle for PKCE, which breaks
  // the user-gesture chain — Chrome/Safari then silently suppress the popup.
  // Opening about:blank first preserves the gesture; we navigate it to the
  // real auth URL once PKCE has been generated.
  const popup = window.open('about:blank', 'eo-gdrive-auth', 'width=520,height=640,noopener=0');

  const { url, verifier } = await buildAuthUrl('popup');
  localStorage.setItem(SS_CODE_VERIFIER, verifier);

  if (popup && !popup.closed) {
    try { popup.location.href = url; } catch { /* ignore — popup may have navigated */ }
    sessionStorage.setItem(SS_POPUP_RESOLVE, '1');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Google Drive sign-in timed out'));
      }, 300_000); // 5 min

      // ── BroadcastChannel: primary signal path ─────────────────
      // Works across COOP boundaries, which window.opener.postMessage
      // does not.
      let channel: BroadcastChannel | null = null;
      try {
        channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
        channel.onmessage = (ev: MessageEvent) => {
          if (ev.data?.type === 'eo-gdrive-oauth-success') {
            adoptTokensFromMessage(ev.data);
            completeSuccess();
          }
        };
      } catch {
        /* BroadcastChannel unsupported — fall back to postMessage only */
      }

      // ── Legacy postMessage path (COOP-vulnerable, kept as fallback) ──
      function onMessage(event: MessageEvent) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'eo-gdrive-oauth-success') {
          adoptTokensFromMessage(event.data);
          completeSuccess();
        }
      }

      function adoptTokensFromMessage(data: unknown): void {
        const payload = (data as { tokens?: { access_token?: string; refresh_token?: string; expires_at?: number } }).tokens;
        if (!payload?.access_token || !payload.expires_at) return;
        writeTokens({
          accessToken: payload.access_token,
          refreshToken: payload.refresh_token ?? null,
          expiresAt: payload.expires_at,
        });
      }

      function completeSuccess() {
        cleanup();
        // Best-effort close from the opener side. Under COOP this may no-op,
        // in which case the popup's placeholder UI will instruct the user to
        // close the window manually.
        try { popup?.close(); } catch { /* ignore */ }
        resolve();
      }

      function onInterval() {
        // Check tokens FIRST — prioritise success over cancellation in the
        // race where the popup wrote tokens then closed in the same tick.
        if (isConnected()) {
          completeSuccess();
          return;
        }
        if (!popup || popup.closed) {
          cleanup();
          reject(new Error('Google Drive sign-in was cancelled'));
        }
      }

      const pollInterval = setInterval(onInterval, 500);

      function cleanup() {
        clearTimeout(timeout);
        clearInterval(pollInterval);
        window.removeEventListener('message', onMessage);
        try { channel?.close(); } catch { /* ignore */ }
        sessionStorage.removeItem(SS_POPUP_RESOLVE);
      }

      window.addEventListener('message', onMessage);
    });
    return;
  }

  // ── Popup blocked — fall back to redirect ─────────────────
  // Regenerate URL with redirect state so handleOAuthCallback knows not to close.
  const { url: redirectUrl, verifier: redirectVerifier } = await buildAuthUrl('redirect');
  localStorage.setItem(SS_CODE_VERIFIER, redirectVerifier);
  sessionStorage.setItem(SS_PENDING_ROUTE, window.location.hash || '#/');
  window.location.href = redirectUrl;
  // Page navigates away — execution stops here.
  // handleOAuthCallback() will be called when the user returns.
  await new Promise<void>(() => { /* never resolves — page is navigating */ });
}
