/**
 * EoServerClient — WebSocket client for the EO-DB backend server.
 *
 * Connects to the backend's /sync WebSocket endpoint, subscribes to all
 * events, and provides a sendEvent() method for pushing local dispatches
 * to the server so they broadcast to every other connected client.
 *
 * Reconnects automatically with exponential backoff (2s, 4s, 8s, 16s).
 */

import type { EoEvent, EoEventInput } from '../db/types';

export class EoServerClient {
  private serverUrl: string;
  private accessToken: string;
  private ws: WebSocket | null = null;
  private onEventCallback: ((event: EoEvent) => void) | null = null;
  private currentSeq = 0;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called when the WebSocket connection is established. */
  onConnected?: () => void;
  /** Called when the WebSocket connection closes (intentionally or not). */
  onDisconnected?: () => void;

  constructor(serverUrl: string, accessToken: string) {
    this.serverUrl = serverUrl.replace(/\/$/, '');
    this.accessToken = accessToken;
  }

  /**
   * Open the WebSocket and start receiving events.
   * @param currentSeq  Local store's current seq — used to request only new events on backfill.
   * @param onEvent     Called for each incoming EoEvent from the server.
   */
  connect(currentSeq: number, onEvent: (event: EoEvent) => void): void {
    this.currentSeq = currentSeq;
    this.onEventCallback = onEvent;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  /** Close the connection permanently (no reconnect). */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.onDisconnected?.();
  }

  /**
   * POST a local event to the server so it is folded server-side and broadcast
   * to all other connected clients.  Fire-and-forget: errors are logged but
   * never thrown, so a failing push never breaks local dispatch.
   */
  sendEvent(event: EoEventInput): void {
    const op = event.op.toLowerCase();
    const url = `${this.serverUrl}/ops/${op}`;
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        target: event.target,
        operand: event.operand,
        ts: event.ts,
        client_event_id: event.client_event_id,
        matrix_token: this.accessToken,
      }),
    }).catch((e) => {
      console.warn('[EO-DB] Server push failed:', e);
    });
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private openSocket(): void {
    // Convert http(s) scheme to ws(s) for WebSocket URL
    const wsBase = this.serverUrl.replace(/^http/, 'ws');
    const url = `${wsBase}/sync?access_token=${encodeURIComponent(this.accessToken)}`;

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      // Request backfill from our current seq and auto-subscribe to live events
      ws.send(JSON.stringify({ type: 'sync', since: this.currentSeq }));
      this.onConnected?.();
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data as string);
        if (msg.type === 'event' && msg.event) {
          const event = msg.event as EoEvent;
          // Advance our tracked seq so reconnects don't re-deliver old events
          if (event.seq > this.currentSeq) {
            this.currentSeq = event.seq;
          }
          this.onEventCallback?.(event);
        }
      } catch {
        // Malformed message — ignore
      }
    };

    ws.onclose = (evt) => {
      this.ws = null;
      // Auth failures (4401/4403) are permanent — don't reconnect
      if (!this.intentionalClose && evt.code !== 4401 && evt.code !== 4403) {
        this.scheduleReconnect();
      } else {
        this.onDisconnected?.();
      }
    };

    // onerror always fires before onclose; let onclose handle reconnect logic
    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    const delays = [2000, 4000, 8000, 16000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) {
        this.openSocket();
      }
    }, delay);
  }
}
