import * as sdk from 'matrix-js-sdk';

const SESSION_KEY = 'eo-db-session';

export interface MatrixSession {
  userId: string;
  deviceId: string;
  accessToken: string;
  homeserver: string;
}

/**
 * Normalize a homeserver input into a full base URL.
 * Accepts "matrix.org", "https://matrix.org", "matrix.org:8448", etc.
 */
export function normalizeHomeserver(input: string): string {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url.replace(/\/+$/, '');
}

/**
 * Convert a username input to a fully qualified Matrix user ID.
 * e.g. "alice" + "matrix.org" → "@alice:matrix.org"
 */
export function toMatrixUserId(username: string, homeserver: string): string {
  const user = username.trim();
  if (user.startsWith('@')) return user;
  const host = homeserver.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').replace(/:\d+$/, '');
  return `@${user}:${host}`;
}

/**
 * Authenticate against the given Matrix homeserver.
 * Returns a session object stored in localStorage for persistence.
 */
export async function login(homeserver: string, username: string, password: string): Promise<MatrixSession> {
  const baseUrl = normalizeHomeserver(homeserver);
  const client = sdk.createClient({ baseUrl });

  const response = await client.login('m.login.password', {
    user: username,
    password,
  });

  const session: MatrixSession = {
    userId: response.user_id,
    deviceId: response.device_id,
    accessToken: response.access_token,
    homeserver: baseUrl,
  };

  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

/**
 * Restore a previously saved session from localStorage.
 */
export function restoreSession(): MatrixSession | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.homeserver) {
      // Old session without homeserver — force re-login
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return parsed as MatrixSession;
  } catch {
    return null;
  }
}

/**
 * Clear the session and discard all local auth state.
 */
export function logout(): void {
  localStorage.removeItem(SESSION_KEY);
}

/**
 * Create an initialized Matrix client from an existing session.
 * Used by sync and event bridge modules.
 */
export function createMatrixClient(session: MatrixSession): sdk.MatrixClient {
  return sdk.createClient({
    baseUrl: session.homeserver,
    userId: session.userId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
  });
}
