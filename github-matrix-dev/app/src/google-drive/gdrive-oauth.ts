/**
 * Google Drive OAuth2 PKCE — browser-native authentication.
 *
 * No client secret is used. All tokens are stored in localStorage.
 * The popup approach is preferred; the redirect flow is the fallback
 * when popups are blocked.
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
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// localStorage / sessionStorage keys
const LS_ACCESS_TOKEN = 'eo-gdrive-access-token';
const LS_REFRESH_TOKEN = 'eo-gdrive-refresh-token';
const LS_EXPIRES_AT = 'eo-gdrive-expires-at';
const SS_CODE_VERIFIER = 'eo-gdrive-code-verifier';
const SS_PENDING_ROUTE = 'eo-gdrive-pending-route';
const SS_POPUP_RESOLVE = 'eo-gdrive-popup-pending';

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

async function buildAuthUrl(): Promise<{ url: string; verifier: string }> {
  const verifier = await generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  const params = new URLSearchParams({
    client_id: _clientId,
    redirect_uri: _redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
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
  const refreshToken = localStorage.getItem(LS_REFRESH_TOKEN);
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
  // refresh_token may not be returned; keep the existing one
  storeTokens({ ...json, refresh_token: json.refresh_token ?? refreshToken ?? undefined });
}

function storeTokens(tokens: TokenResponse): void {
  localStorage.setItem(LS_ACCESS_TOKEN, tokens.access_token);
  if (tokens.refresh_token) {
    localStorage.setItem(LS_REFRESH_TOKEN, tokens.refresh_token);
  }
  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  localStorage.setItem(LS_EXPIRES_AT, String(expiresAt));
}

// ──────────────────────────────────────────────────────────────
// Public token API
// ──────────────────────────────────────────────────────────────

/** Returns true when there's a stored token that is not expired. */
export function isConnected(): boolean {
  const token = localStorage.getItem(LS_ACCESS_TOKEN);
  const expiresAt = Number(localStorage.getItem(LS_EXPIRES_AT) ?? '0');
  return !!token && Date.now() < expiresAt - 60_000;
}

/**
 * Get a valid Google access token, refreshing automatically if needed.
 * Throws if no tokens are stored (user must call startOAuthFlow first).
 */
export async function getAccessToken(): Promise<string> {
  const token = localStorage.getItem(LS_ACCESS_TOKEN);
  const expiresAt = Number(localStorage.getItem(LS_EXPIRES_AT) ?? '0');
  if (!token) throw new Error('Not authenticated with Google Drive');
  if (Date.now() >= expiresAt - 60_000) {
    await refreshTokens();
  }
  return localStorage.getItem(LS_ACCESS_TOKEN)!;
}

/** Clear all stored tokens (sign out of Google Drive). */
export function clearTokens(): void {
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_REFRESH_TOKEN);
  localStorage.removeItem(LS_EXPIRES_AT);
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

  const verifier = sessionStorage.getItem(SS_CODE_VERIFIER);
  if (!verifier) {
    console.warn('[EO-DB] OAuth callback: no code_verifier in sessionStorage');
    return false;
  }

  try {
    await exchangeCode(code, verifier);
    sessionStorage.removeItem(SS_CODE_VERIFIER);

    // If we are inside a popup, signal the opener and close
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(
        { type: 'eo-gdrive-oauth-success' },
        window.location.origin,
      );
      window.close();
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

  const { url, verifier } = await buildAuthUrl();
  sessionStorage.setItem(SS_CODE_VERIFIER, verifier);

  // ── Attempt popup ──────────────────────────────────────────
  const popup = window.open(url, 'eo-gdrive-auth', 'width=520,height=640,noopener=0');

  if (popup && !popup.closed) {
    sessionStorage.setItem(SS_POPUP_RESOLVE, '1');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Google Drive sign-in timed out'));
      }, 300_000); // 5 min

      function onMessage(event: MessageEvent) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'eo-gdrive-oauth-success') {
          cleanup();
          resolve();
        }
      }

      function onInterval() {
        if (!popup || popup.closed) {
          cleanup();
          // If tokens were stored the user completed the flow
          if (isConnected()) {
            resolve();
          } else {
            reject(new Error('Google Drive sign-in was cancelled'));
          }
        }
      }

      const pollInterval = setInterval(onInterval, 500);

      function cleanup() {
        clearTimeout(timeout);
        clearInterval(pollInterval);
        window.removeEventListener('message', onMessage);
        sessionStorage.removeItem(SS_POPUP_RESOLVE);
      }

      window.addEventListener('message', onMessage);
    });
    return;
  }

  // ── Popup blocked — fall back to redirect ─────────────────
  sessionStorage.setItem(SS_PENDING_ROUTE, window.location.hash || '#/');
  window.location.href = url;
  // Page navigates away — execution stops here.
  // handleOAuthCallback() will be called when the user returns.
  await new Promise<void>(() => { /* never resolves — page is navigating */ });
}
