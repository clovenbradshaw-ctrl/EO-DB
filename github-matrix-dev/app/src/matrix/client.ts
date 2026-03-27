import * as sdk from 'matrix-js-sdk';

const HOMESERVER = 'https://app.aminoimmigration.com';
const SESSION_KEY = 'eo-db-session';

export interface MatrixSession {
  userId: string;
  deviceId: string;
  accessToken: string;
}

/**
 * Authenticate against the Matrix homeserver.
 * Returns a session object stored in localStorage for persistence.
 */
export async function login(username: string, password: string): Promise<MatrixSession> {
  const client = sdk.createClient({ baseUrl: HOMESERVER });

  const response = await client.login('m.login.password', {
    user: username,
    password,
  });

  const session: MatrixSession = {
    userId: response.user_id,
    deviceId: response.device_id,
    accessToken: response.access_token,
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
    return JSON.parse(raw) as MatrixSession;
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
    baseUrl: HOMESERVER,
    userId: session.userId,
    deviceId: session.deviceId,
    accessToken: session.accessToken,
  });
}
