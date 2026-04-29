/**
 * EO/// DB Airtable Gateway — single-entry wrapper.
 *
 * Every call to the Airtable side of the app goes through `gateway()`. The
 * wrapper owns three things:
 *   1. The Matrix bearer header (validated server-side via /account/whoami).
 *   2. The `{ ok, data }` envelope — callers receive `data` directly.
 *   3. The 401-means-reauth contract — a 401 throws `AuthError` after the
 *      Matrix session has been invalidated locally.
 *
 * If we ever swap n8n for direct Airtable calls (or a Postgres backend),
 * this is the only file that changes.
 */
import { restoreSession, logout } from '../../matrix/client';

export const GATEWAY_URL = 'https://n8n.intelechia.com/webhook/eodb/airtable';

export type GatewayOp = 'schema' | 'sync' | 'search' | 'update';

export interface GatewayBody {
  op: GatewayOp;
  site?: { base?: string; table?: string; recordId?: string };
  /**
   * ISO timestamp cursor for op:sync. Pinned across the whole pagination
   * loop of a single run — if you advance it per-page, Airtable's opaque
   * `offset` (which is bound to the filter+sort it was issued under) stops
   * being valid.
   */
  since?: string;
  /**
   * Airtable's opaque pagination token, forwarded as the `offset` query
   * param to the upstream Airtable list-records call. Null/omitted on the
   * first call of a run; carry whatever the previous response returned on
   * each subsequent call.
   */
  offset?: string;
  /** Page size cap for op:sync / op:search (max 100 server-side). */
  limit?: number;
  /** Airtable formula for op:search. */
  filterByFormula?: string;
  /** Field map for op:update. */
  payload?: Record<string, unknown>;
}

export class GatewayError extends Error {
  constructor(public readonly code: string, public readonly detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'GatewayError';
  }
}

export class AuthError extends GatewayError {
  constructor(detail?: string) {
    super('unauthorized', detail);
    this.name = 'AuthError';
  }
}

/** Read the current Matrix access token from the persisted session. */
export function getMatrixToken(): string {
  const session = restoreSession();
  if (!session?.accessToken) {
    throw new AuthError('No Matrix session — sign in first.');
  }
  return session.accessToken;
}

/**
 * Drop the local Matrix session so the UI's restore-on-mount path will route
 * the user to the login screen on the next render. The gateway has already
 * told us the token isn't valid; there's nothing to refresh on the wire.
 */
export function refreshMatrixSession(): void {
  logout();
}

interface AminoEnvelopeOk<T> { ok: true; data: T }
interface AminoEnvelopeErr { ok: false; error: string; detail?: string }
type AminoEnvelope<T> = AminoEnvelopeOk<T> | AminoEnvelopeErr;

/**
 * POST one op to the gateway and return the unwrapped `data`. Throws on
 * 401 (after invalidating the local session) and on any `{ ok: false }`
 * envelope.
 */
export async function gateway<T = unknown>(body: GatewayBody): Promise<T> {
  const token = getMatrixToken();
  const res = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  let parsed: AminoEnvelope<T> | null = null;
  const text = await res.text();
  try { parsed = JSON.parse(text) as AminoEnvelope<T>; } catch { parsed = null; }

  if (res.status === 401) {
    refreshMatrixSession();
    const detail = parsed && parsed.ok === false ? parsed.detail : text.slice(0, 200);
    throw new AuthError(detail);
  }

  if (!parsed) {
    throw new GatewayError(
      'non_json_response',
      `Gateway returned non-JSON (${res.status} ${res.statusText}): ${text.slice(0, 200)}`,
    );
  }

  if (parsed.ok === false) {
    throw new GatewayError(parsed.error, parsed.detail);
  }

  if (!res.ok) {
    throw new GatewayError('http_error', `${res.status} ${res.statusText}`);
  }

  return parsed.data;
}
