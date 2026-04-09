/**
 * EO Server store — manages the connection to the EO-DB backend for
 * real-time field sync between users.
 *
 * When a server URL is configured, any dispatched event is also POSTed to
 * the server, which folds it and broadcasts it to all other connected
 * clients via the /sync WebSocket endpoint.  Incoming events are folded
 * locally by the callback provided to connect().
 *
 * Server URL is persisted to localStorage under 'eo-server-url'.
 */

import { create } from 'zustand';
import { EoServerClient } from '../services/eo-server-client';
import type { EoEvent, EoEventInput } from '../db/types';

interface EoServerState {
  /** Base URL of the EO-DB backend, e.g. "http://localhost:3000". */
  serverUrl: string | null;
  /** Whether the WebSocket is currently open. */
  connected: boolean;
  /** The active client instance (null if not connected). */
  client: EoServerClient | null;

  /** Persist server URL to localStorage and update state. */
  setServerUrl: (url: string | null) => void;

  /**
   * Create a new EoServerClient and open the WebSocket.
   * @param currentSeq   Current local store seq — for backfill.
   * @param accessToken  Matrix access token used to authenticate with the server.
   * @param onEvent      Called with each incoming EoEvent to fold it locally.
   */
  connect: (currentSeq: number, accessToken: string, onEvent: (event: EoEvent) => void) => void;

  /** Close the WebSocket and clear the client. */
  disconnect: () => void;

  /**
   * Push a locally-dispatched event to the server for broadcast.
   * No-op if not connected.
   */
  sendEvent: (event: EoEventInput) => void;
}

function readServerUrl(): string | null {
  try {
    return localStorage.getItem('eo-server-url') || null;
  } catch {
    return null;
  }
}

export const useEoServerStore = create<EoServerState>((set, get) => ({
  serverUrl: readServerUrl(),
  connected: false,
  client: null,

  setServerUrl(url) {
    const trimmed = url ? url.trim().replace(/\/$/, '') : null;
    try {
      if (trimmed) {
        localStorage.setItem('eo-server-url', trimmed);
      } else {
        localStorage.removeItem('eo-server-url');
      }
    } catch { /* quota exceeded — silently drop */ }
    set({ serverUrl: trimmed });
  },

  connect(currentSeq, accessToken, onEvent) {
    const { serverUrl, client: existing } = get();
    if (!serverUrl || !accessToken) return;

    // Tear down any existing connection before creating a new one
    if (existing) {
      existing.disconnect();
    }

    const client = new EoServerClient(serverUrl, accessToken);
    client.onConnected = () => set({ connected: true });
    client.onDisconnected = () => set({ connected: false });
    client.connect(currentSeq, onEvent);

    set({ client, connected: false }); // connected flips to true via onConnected
  },

  disconnect() {
    const { client } = get();
    if (client) {
      client.disconnect();
    }
    set({ client: null, connected: false });
  },

  sendEvent(event) {
    const { client, connected } = get();
    if (client && connected) {
      client.sendEvent(event);
    }
  },
}));
