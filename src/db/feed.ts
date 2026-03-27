import type { EoEvent, Subscription, Operator } from './types.js';
import { v4 as uuidv4 } from 'uuid';

export class Feed {
  private subscriptions: Map<string, Subscription> = new Map();

  subscribe(pattern: string, callback: (event: EoEvent) => void, ops?: Operator[]): string {
    const id = uuidv4();
    this.subscriptions.set(id, { id, target_pattern: pattern, ops, callback });
    return id;
  }

  unsubscribe(id: string): void {
    this.subscriptions.delete(id);
  }

  notify(event: EoEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (this.matches(sub, event)) {
        sub.callback(event);
      }
    }
  }

  private matches(sub: Subscription, event: EoEvent): boolean {
    if (sub.ops && sub.ops.length > 0 && !sub.ops.includes(event.op)) {
      return false;
    }
    return globMatch(sub.target_pattern, event.target);
  }
}

export function globMatch(pattern: string, target: string): boolean {
  const patternParts = pattern.split('.');
  const targetParts = target.split('.');
  return matchParts(patternParts, 0, targetParts, 0);
}

function matchParts(
  pattern: string[], pi: number,
  target: string[], ti: number
): boolean {
  while (pi < pattern.length && ti < target.length) {
    if (pattern[pi] === '**') {
      // ** matches zero or more segments
      // Try matching the rest of the pattern from every remaining position
      for (let k = ti; k <= target.length; k++) {
        if (matchParts(pattern, pi + 1, target, k)) return true;
      }
      return false;
    }
    if (pattern[pi] === '*') {
      // * matches exactly one segment
      pi++;
      ti++;
      continue;
    }
    if (pattern[pi] !== target[ti]) return false;
    pi++;
    ti++;
  }

  // Handle trailing **
  while (pi < pattern.length && pattern[pi] === '**') pi++;

  return pi === pattern.length && ti === target.length;
}
