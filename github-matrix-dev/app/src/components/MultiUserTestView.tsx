/**
 * Multi-User Visibility Test
 *
 * Simulates two independent users within the same browser tab, each with
 * their own isolated IndexedDB store and fold engine. Actions performed
 * by one user are broadcast to the other via an in-memory event bus,
 * demonstrating that cross-user visibility works correctly.
 *
 * Each panel shows:
 *  - A button to create records (INS) and update them (SYN)
 *  - A live event log of everything the user has processed
 *  - Projected state for all targets
 *  - Visual indicators when events arrive from the OTHER user
 */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createIdb } from '../db/idb';
import { createLocalStore } from '../db/encrypted-store';
import { processEvent } from '../db/fold';
import { readLogSince } from '../db/log';
import { getStateByPrefix } from '../db/state';
import type { EoStore } from '../db/encrypted-store';
import type { EoEvent, EoEventInput, EoState } from '../db/types';
import { useTheme, type Theme } from '../theme';

// ---------------------------------------------------------------------------
// In-memory event bus — simulates network broadcast between users
// ---------------------------------------------------------------------------

type BusListener = (event: EoEventInput, fromUser: string) => void;

function createEventBus() {
  const listeners = new Set<BusListener>();
  return {
    subscribe(fn: BusListener) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    publish(event: EoEventInput, fromUser: string) {
      for (const fn of listeners) fn(event, fromUser);
    },
  };
}

// ---------------------------------------------------------------------------
// Per-user isolated store + fold
// ---------------------------------------------------------------------------

interface UserSession {
  userId: string;
  label: string;
  color: string;
  store: EoStore | null;
  events: EoEvent[];
  states: EoState[];
  ready: boolean;
  /** Tracks targets that just arrived from the remote user (for flash highlight) */
  remoteFlash: Set<string>;
}

const INITIAL_SESSION = (userId: string, label: string, color: string): UserSession => ({
  userId, label, color, store: null, events: [], states: [], ready: false, remoteFlash: new Set(),
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MultiUserTestView() {
  const { theme } = useTheme();
  const busRef = useRef(createEventBus());

  const [userA, setUserA] = useState<UserSession>(() => INITIAL_SESSION('@alice:local', 'Alice', '#6366f1'));
  const [userB, setUserB] = useState<UserSession>(() => INITIAL_SESSION('@bob:local', 'Bob', '#f59e0b'));
  const [testLog, setTestLog] = useState<string[]>([]);

  const storeARef = useRef<EoStore | null>(null);
  const storeBRef = useRef<EoStore | null>(null);

  const log = useCallback((msg: string) => {
    setTestLog((prev) => [...prev.slice(-49), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  // --- Initialize isolated stores ---
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Use unique DB names so the two stores don't collide
      const idbA = await createIdb('__test_alice__');
      const idbB = await createIdb('__test_bob__');
      const storeA = createLocalStore(idbA);
      const storeB = createLocalStore(idbB);
      if (cancelled) return;

      storeARef.current = storeA;
      storeBRef.current = storeB;

      setUserA((prev) => ({ ...prev, store: storeA, ready: true }));
      setUserB((prev) => ({ ...prev, store: storeB, ready: true }));
    }

    init();
    return () => { cancelled = true; };
  }, []);

  // --- Subscribe each user to the event bus (receive remote events) ---
  useEffect(() => {
    const unsub = busRef.current.subscribe(async (event, fromUser) => {
      // Deliver to the OTHER user's store
      if (fromUser === '@alice:local' && storeBRef.current) {
        await processEvent(storeBRef.current, event, () => {});
        await refreshUser(storeBRef.current, setUserB, event.target);
        log(`Bob received ${event.op} on ${event.target} from Alice`);
      } else if (fromUser === '@bob:local' && storeARef.current) {
        await processEvent(storeARef.current, event, () => {});
        await refreshUser(storeARef.current, setUserA, event.target);
        log(`Alice received ${event.op} on ${event.target} from Bob`);
      }
    });
    return unsub;
  }, [log]);

  async function refreshUser(
    store: EoStore,
    setter: React.Dispatch<React.SetStateAction<UserSession>>,
    flashTarget?: string,
  ) {
    const events = await readLogSince(store, 0);
    const states = await getStateByPrefix(store, '');
    setter((prev) => {
      const flash = new Set(prev.remoteFlash);
      if (flashTarget) flash.add(flashTarget);
      return { ...prev, events: events.slice(-50), states, remoteFlash: flash };
    });
    // Clear flash after 1.5s
    if (flashTarget) {
      setTimeout(() => {
        setter((prev) => {
          const flash = new Set(prev.remoteFlash);
          flash.delete(flashTarget);
          return { ...prev, remoteFlash: flash };
        });
      }, 1500);
    }
  }

  // --- Action dispatchers ---
  const nextId = useRef(1);

  async function dispatchAction(
    userId: string,
    store: EoStore,
    setter: React.Dispatch<React.SetStateAction<UserSession>>,
    op: 'INS' | 'SYN' | 'DEF' | 'CON',
    target: string,
    operand: any,
  ) {
    const event: EoEventInput = {
      op,
      target,
      operand,
      agent: userId,
      ts: new Date().toISOString(),
      acquired_ts: new Date().toISOString(),
    };

    await processEvent(store, event, () => {});
    await refreshUser(store, setter);

    const label = userId === '@alice:local' ? 'Alice' : 'Bob';
    log(`${label} dispatched ${op} on ${target}`);

    // Broadcast to other users via bus
    busRef.current.publish(event, userId);
  }

  function handleCreateRecord(userId: string, store: EoStore | null, setter: React.Dispatch<React.SetStateAction<UserSession>>) {
    if (!store) return;
    const id = nextId.current++;
    const target = `tblTest.rec${id}`;
    const label = userId === '@alice:local' ? 'Alice' : 'Bob';
    dispatchAction(userId, store, setter, 'INS', target, {
      name: `Record ${id} by ${label}`,
      created_by: label,
      timestamp: new Date().toLocaleTimeString(),
    });
  }

  function handleUpdateRecord(userId: string, store: EoStore | null, setter: React.Dispatch<React.SetStateAction<UserSession>>, target: string) {
    if (!store) return;
    const label = userId === '@alice:local' ? 'Alice' : 'Bob';
    dispatchAction(userId, store, setter, 'SYN', target, {
      updated_by: label,
      updated_at: new Date().toLocaleTimeString(),
      note: `Edited by ${label}`,
    });
  }

  function handleDefineField(userId: string, store: EoStore | null, setter: React.Dispatch<React.SetStateAction<UserSession>>) {
    if (!store) return;
    const id = nextId.current++;
    dispatchAction(userId, store, setter, 'DEF', `tblTest.fld${id}`, {
      type: 'text',
      label: `Field ${id}`,
    });
  }

  async function handleReset() {
    // Delete test databases
    const delDb = (name: string) => new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    await Promise.all([delDb('eo-db::__test_alice__'), delDb('eo-db::__test_bob__')]);

    // Re-init
    const idbA = await createIdb('__test_alice__');
    const idbB = await createIdb('__test_bob__');
    const storeA = createLocalStore(idbA);
    const storeB = createLocalStore(idbB);
    storeARef.current = storeA;
    storeBRef.current = storeB;
    nextId.current = 1;

    setUserA({ ...INITIAL_SESSION('@alice:local', 'Alice', '#6366f1'), store: storeA, ready: true });
    setUserB({ ...INITIAL_SESSION('@bob:local', 'Bob', '#f59e0b'), store: storeB, ready: true });
    setTestLog([]);
    log('Test environment reset');
  }

  const s = styles(theme);

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h2 style={s.title}>Multi-User Visibility Test</h2>
        <p style={s.subtitle}>
          Two simulated users with isolated stores. Actions by one user are broadcast to the other
          via an in-memory event bus, verifying cross-user visibility.
        </p>
        <button style={s.resetBtn} onClick={handleReset}>Reset Test</button>
      </div>

      <div style={s.panels}>
        <UserPanel
          user={userA}
          theme={theme}
          onCreateRecord={() => handleCreateRecord('@alice:local', userA.store, setUserA)}
          onUpdateRecord={(t) => handleUpdateRecord('@alice:local', userA.store, setUserA, t)}
          onDefineField={() => handleDefineField('@alice:local', userA.store, setUserA)}
        />
        <UserPanel
          user={userB}
          theme={theme}
          onCreateRecord={() => handleCreateRecord('@bob:local', userB.store, setUserB)}
          onUpdateRecord={(t) => handleUpdateRecord('@bob:local', userB.store, setUserB, t)}
          onDefineField={() => handleDefineField('@bob:local', userB.store, setUserB)}
        />
      </div>

      <div style={s.busLog}>
        <div style={s.busLogTitle}>Event Bus Log</div>
        <div style={s.busLogScroll}>
          {testLog.length === 0 && <div style={s.busLogEmpty}>Perform actions above to see cross-user events here</div>}
          {testLog.map((msg, i) => (
            <div key={i} style={s.busLogEntry}>{msg}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// User Panel sub-component
// ---------------------------------------------------------------------------

function UserPanel({ user, theme, onCreateRecord, onUpdateRecord, onDefineField }: {
  user: UserSession;
  theme: Theme;
  onCreateRecord: () => void;
  onUpdateRecord: (target: string) => void;
  onDefineField: () => void;
}) {
  const s = panelStyles(theme, user.color);

  if (!user.ready) {
    return (
      <div style={s.panel}>
        <div style={s.panelHeader}>{user.label}</div>
        <div style={s.loading}>Initializing store...</div>
      </div>
    );
  }

  return (
    <div style={s.panel}>
      <div style={s.panelHeader}>
        <span style={s.avatar}>{user.label[0]}</span>
        <span>{user.label}</span>
        <span style={s.userId}>{user.userId}</span>
      </div>

      <div style={s.actions}>
        <button style={s.actionBtn} onClick={onCreateRecord}>+ Create Record</button>
        <button style={s.actionBtn} onClick={onDefineField}>+ Define Field</button>
      </div>

      {/* Projected State */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Projected State ({user.states.length})</div>
        <div style={s.stateList}>
          {user.states.length === 0 && <div style={s.emptyHint}>No state yet — create a record</div>}
          {user.states.map((st) => (
            <div
              key={st.target}
              style={{
                ...s.stateRow,
                ...(user.remoteFlash.has(st.target) ? s.flashHighlight : {}),
              }}
            >
              <div style={s.stateTarget}>{st.target}</div>
              <div style={s.stateMeta}>
                <span>by {st.last_agent}</span>
                <span style={s.stateOp}>{st.last_op}</span>
                {st.last_agent !== user.userId && (
                  <span style={s.remoteBadge}>remote</span>
                )}
              </div>
              <pre style={s.stateValue}>{JSON.stringify(st.value, null, 2)}</pre>
              <button
                style={s.miniBtn}
                onClick={() => onUpdateRecord(st.target)}
              >
                SYN (update)
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Event Log */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Event Log ({user.events.length})</div>
        <div style={s.eventList}>
          {user.events.length === 0 && <div style={s.emptyHint}>No events yet</div>}
          {[...user.events].reverse().map((ev) => (
            <div key={ev.seq} style={s.eventRow}>
              <span style={s.eventSeq}>#{ev.seq}</span>
              <span style={s.eventOp}>{ev.op}</span>
              <span style={s.eventTarget}>{ev.target}</span>
              <span style={s.eventAgent}>
                {ev.agent === user.userId ? 'local' : 'remote'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styles(theme: Theme): Record<string, React.CSSProperties> {
  return {
    root: {
      display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto',
      padding: 20, gap: 16,
    },
    header: {
      textAlign: 'center', marginBottom: 8,
    },
    title: {
      margin: 0, fontSize: 20, fontWeight: 700, color: theme.text,
    },
    subtitle: {
      margin: '6px 0 0', fontSize: 13, color: theme.textSecondary, maxWidth: 600,
      marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5,
    },
    resetBtn: {
      marginTop: 10, padding: '6px 16px', fontSize: 12, fontWeight: 600,
      background: theme.dangerBg, color: theme.danger, border: `1px solid ${theme.dangerBorder}`,
      borderRadius: 6, cursor: 'pointer',
    },
    panels: {
      display: 'flex', gap: 16, flex: 1, minHeight: 0,
    },
    busLog: {
      background: theme.bgCard, border: `1px solid ${theme.border}`, borderRadius: 8,
      padding: 12, maxHeight: 180, display: 'flex', flexDirection: 'column',
    },
    busLogTitle: {
      fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 6,
    },
    busLogScroll: {
      flex: 1, overflow: 'auto', fontSize: 11, fontFamily: 'monospace', color: theme.textSecondary,
    },
    busLogEmpty: {
      color: theme.textMuted, fontStyle: 'italic',
    },
    busLogEntry: {
      padding: '2px 0', borderBottom: `1px solid ${theme.borderLight}`,
    },
  };
}

function panelStyles(theme: Theme, color: string): Record<string, React.CSSProperties> {
  return {
    panel: {
      flex: 1, display: 'flex', flexDirection: 'column', gap: 10,
      background: theme.bgCard, border: `1px solid ${theme.border}`, borderRadius: 10,
      padding: 14, overflow: 'auto', minWidth: 0,
    },
    panelHeader: {
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 15, fontWeight: 700, color: theme.text,
      borderBottom: `2px solid ${color}`, paddingBottom: 8,
    },
    avatar: {
      width: 28, height: 28, borderRadius: '50%', background: color,
      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 700, flexShrink: 0,
    },
    userId: {
      fontSize: 11, color: theme.textMuted, fontWeight: 400, marginLeft: 'auto',
    },
    loading: {
      color: theme.textMuted, fontSize: 13, padding: 20, textAlign: 'center',
    },
    actions: {
      display: 'flex', gap: 6, flexWrap: 'wrap',
    },
    actionBtn: {
      padding: '5px 12px', fontSize: 12, fontWeight: 600,
      background: theme.accentBg, color: theme.accent, border: `1px solid ${theme.accentBorder}`,
      borderRadius: 6, cursor: 'pointer',
    },
    section: {
      display: 'flex', flexDirection: 'column', gap: 4,
    },
    sectionTitle: {
      fontSize: 12, fontWeight: 600, color: theme.textSecondary, textTransform: 'uppercase' as const,
      letterSpacing: 0.5,
    },
    stateList: {
      display: 'flex', flexDirection: 'column', gap: 6,
    },
    stateRow: {
      background: theme.bgMuted, borderRadius: 6, padding: 8,
      border: `1px solid ${theme.borderLight}`,
      transition: 'background 0.3s ease, border-color 0.3s ease',
    },
    flashHighlight: {
      background: `${color}22`, borderColor: color,
    },
    stateTarget: {
      fontSize: 13, fontWeight: 600, color: theme.text, fontFamily: 'monospace',
    },
    stateMeta: {
      display: 'flex', gap: 8, fontSize: 11, color: theme.textMuted, marginTop: 2,
    },
    stateOp: {
      background: theme.accentBg, color: theme.accent, padding: '0 4px',
      borderRadius: 3, fontSize: 10, fontWeight: 600,
    },
    remoteBadge: {
      background: `${color}33`, color, padding: '0 5px',
      borderRadius: 3, fontSize: 10, fontWeight: 600,
    },
    stateValue: {
      margin: '4px 0 0', fontSize: 11, color: theme.textSecondary, fontFamily: 'monospace',
      whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      background: theme.bg, borderRadius: 4, padding: 6, maxHeight: 80, overflow: 'auto',
    },
    miniBtn: {
      marginTop: 4, padding: '3px 8px', fontSize: 10, fontWeight: 600,
      background: 'transparent', color: theme.accent, border: `1px solid ${theme.accentBorder}`,
      borderRadius: 4, cursor: 'pointer',
    },
    eventList: {
      display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 200, overflow: 'auto',
    },
    eventRow: {
      display: 'flex', gap: 8, fontSize: 11, fontFamily: 'monospace',
      padding: '3px 6px', borderRadius: 4, background: theme.bgMuted,
    },
    eventSeq: {
      color: theme.textMuted, minWidth: 30,
    },
    eventOp: {
      fontWeight: 700, color: theme.accent, minWidth: 30,
    },
    eventTarget: {
      color: theme.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
    },
    eventAgent: {
      color: theme.textMuted, fontSize: 10,
    },
    emptyHint: {
      color: theme.textMuted, fontStyle: 'italic', fontSize: 12, padding: 8,
    },
  };
}
