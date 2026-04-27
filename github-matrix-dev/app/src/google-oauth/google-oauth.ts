/**
 * Google OAuth2 PKCE — browser-native authentication.
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

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const SS_ACCESS_TOKEN = 'eo-google-access-token';
const SS_EXPIRES_AT = 'eo-google-expires-at';
const SS_CODE_VERIFIER = 'eo-google-code-verifier';
const SS_PENDING_ROUTE = 'eo-google-pending-route';
const SS_POPUP_RESOLVE = 'eo-google-popup-pending';

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
const OAUTH_BROADCAST_CHANNEL = 'eo-google-oauth';

let _clientId = '';
let _redirectUri = '';

export function initGoogleOAuth(clientId: string, redirectUri: string): void {
  _clientId = clientId;
  _redirectUri = redirectUri;
}

export function isGoogleOAuthConfigured(): boolean {
  return !!_clientId;
}

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

async function buildAuthUrl(mode: 'popup' | 'redirect'): Promise<{ url: string; verifier: string }> {
  if (!_clientId) {
    throw new Error('Google OAuth is not configured for this deployment (VITE_GOOGLE_CLIENT_ID is unset).');
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

export function isConnected(): boolean {
  const cached = getCachedTokens();
  if (!cached) return false;
  return Date.now() < cached.expiresAt - 60_000;
}

export async function getAccessToken(): Promise<string> {
  const cached = getCachedTokens();
  if (!cached) throw new Error('Not authenticated with Google');
  if (Date.now() >= cached.expiresAt - 60_000) {
    await refreshTokens();
  }
  return (_tokens ?? cached).accessToken;
}

export function clearTokens(): void {
  _tokens = null;
  try {
    sessionStorage.removeItem(SS_ACCESS_TOKEN);
    sessionStorage.removeItem(SS_EXPIRES_AT);
  } catch {
    /* ignore */
  }
}

export async function handleOAuthCallback(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;

  const verifier = localStorage.getItem(SS_CODE_VERIFIER);
  if (!verifier) {
    console.warn('[EO-DB] OAuth callback: no code_verifier in localStorage');
    return false;
  }

  try {
    await exchangeCode(code, verifier);
    localStorage.removeItem(SS_CODE_VERIFIER);

    const cached = getCachedTokens();
    try {
      const channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
      channel.postMessage({
        type: 'eo-google-oauth-success',
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

    const state = params.get('state');
    const isPopup = state === 'popup';

    if (isPopup) {
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(
            {
              type: 'eo-google-oauth-success',
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
      try { window.close(); } catch { /* ignore */ }
      return true;
    }

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

export async function startOAuthFlow(): Promise<void> {
  if (isConnected()) return;

  const popup = window.open('about:blank', 'eo-google-auth', 'width=520,height=640,noopener=0');

  const { url, verifier } = await buildAuthUrl('popup');
  localStorage.setItem(SS_CODE_VERIFIER, verifier);

  if (popup && !popup.closed) {
    try { popup.location.href = url; } catch { /* ignore — popup may have navigated */ }
    sessionStorage.setItem(SS_POPUP_RESOLVE, '1');
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Google sign-in timed out'));
      }, 300_000);

      let channel: BroadcastChannel | null = null;
      try {
        channel = new BroadcastChannel(OAUTH_BROADCAST_CHANNEL);
        channel.onmessage = (ev: MessageEvent) => {
          if (ev.data?.type === 'eo-google-oauth-success') {
            adoptTokensFromMessage(ev.data);
            completeSuccess();
          }
        };
      } catch {
        /* BroadcastChannel unsupported — fall back to postMessage only */
      }

      function onMessage(event: MessageEvent) {
        if (event.origin !== window.location.origin) return;
        if (event.data?.type === 'eo-google-oauth-success') {
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
        try { popup?.close(); } catch { /* ignore */ }
        resolve();
      }

      function onInterval() {
        if (isConnected()) {
          completeSuccess();
          return;
        }
        if (!popup || popup.closed) {
          cleanup();
          reject(new Error('Google sign-in was cancelled'));
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

  const { url: redirectUrl, verifier: redirectVerifier } = await buildAuthUrl('redirect');
  localStorage.setItem(SS_CODE_VERIFIER, redirectVerifier);
  sessionStorage.setItem(SS_PENDING_ROUTE, window.location.hash || '#/');
  window.location.href = redirectUrl;
  await new Promise<void>(() => { /* never resolves — page is navigating */ });
}
