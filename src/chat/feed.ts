/**
 * Chat feed — real-time pub/sub for chat messages and room events.
 *
 * Separate from the EO event Feed because chat is space-agnostic
 * and uses its own subscription model (per-room, not per-target-pattern).
 */

import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage } from './types.js';

export type ChatEventType =
  | 'message'
  | 'room_created'
  | 'room_updated'
  | 'room_archived'
  | 'member_added'
  | 'member_removed'
  | 'message_edited'
  | 'message_deleted';

export interface ChatEvent {
  type: ChatEventType;
  room_id: string;
  payload: any;
  ts: string;
}

interface ChatSubscription {
  id: string;
  /** null = subscribe to all rooms, string = specific room. */
  room_id: string | null;
  callback: (event: ChatEvent) => void;
}

export class ChatFeed {
  private subscriptions = new Map<string, ChatSubscription>();

  /** Subscribe to chat events for a specific room (or all rooms if roomId is null). */
  subscribe(roomId: string | null, callback: (event: ChatEvent) => void): string {
    const id = uuidv4();
    this.subscriptions.set(id, { id, room_id: roomId, callback });
    return id;
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id);
  }

  /** Notify subscribers of a new chat message. */
  notifyMessage(roomId: string, message: ChatMessage): void {
    this.emit({
      type: 'message',
      room_id: roomId,
      payload: message,
      ts: new Date().toISOString(),
    });
  }

  /** Notify subscribers of a room-level event (created, updated, member change, etc.). */
  notifyRoomEvent(roomId: string, type: ChatEventType, payload: any): void {
    this.emit({
      type,
      room_id: roomId,
      payload,
      ts: new Date().toISOString(),
    });
  }

  private emit(event: ChatEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.room_id === null || sub.room_id === event.room_id) {
        sub.callback(event);
      }
    }
  }
}
