import { useEffect, useRef, useState } from 'react';
import { RecordView } from './RecordView';
import { formatName } from './scope-picker-utils';
import { useEoStore } from '../store/eo-store';
import { useSliceStore } from '../store/slice-store';
import { useTheme, type Theme } from '../theme';
import type { LayoutDisplayType } from './detail-layout';
import type { TableSliceConfig, SavedSlice } from './slice-types';
import {
  loadSavedDrawerWidth,
  clampDrawerWidth,
  saveDrawerWidth,
} from './drawer-dimensions';

interface RecordDetailDrawerProps {
  target: string;
  onClose: () => void;
  onNavigate: (target: string) => void;
  profileFields?: string[];
  isMobile?: boolean;
  layoutType?: LayoutDisplayType;
  /** Ordered list of record targets from the current table view, for prev/next pager. */
  tableRecordTargets?: string[];
  /** Current user ID (needed to attribute a pinned-record slice to its creator) */
  userId?: string;
  /** Hide the panel while keeping the record selected. The parent is
   *  responsible for rendering a way to un-collapse (e.g., a rail button). */
  onCollapse?: () => void;
}

/** Extract initials from a display name (e.g. "Priya Chandrasekaran" -> "PC") */
function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** Extract entity type from target path (e.g. "import.clients.CLI-001" -> "client") */
function getEntityType(target: string): string {
  const parts = target.split('.');
  if (parts.length >= 2) {
    let collection = parts[parts.length - 2];
    // Singularize: remove trailing 's'
    if (collection.endsWith('s') && collection.length > 1) {
      collection = collection.slice(0, -1);
    }
    return collection.toLowerCase();
  }
  return 'record';
}

/** Extract entity ID from target path (e.g. "import.clients.CLI-001" -> "CLI-001") */
function getEntityId(target: string): string {
  return target.split('.').pop() || target;
}

const TYPE_COLORS: Record<string, string> = {
  client: '#c2700a',
  case: '#16a34a',
  attorney: '#7c5cbf',
  document: '#8b6834',
  billing_account: '#1a6dd4',
  contact: '#c2700a',
  matter: '#0e8a6e',
  task: '#1a6dd4',
  event: '#d9487a',
  note: '#7c5cbf',
};

export function RecordDetailDrawer({ target, onClose, onNavigate, profileFields, isMobile, layoutType, tableRecordTargets, userId, onCollapse }: RecordDetailDrawerProps) {
  const { theme } = useTheme();
  const s = makeStyles(theme);
  const horizon = useEoStore((s) => s.horizon);
  const getState = useEoStore((s) => s.getState);
  const ready = useEoStore((s) => s.ready);
  const dispatch = useEoStore((st) => st.dispatch);
  const sliceStore = useSliceStore();
  const registerSavedSlices = useSliceStore((st) => st.registerSavedSlices);
  const [pinning, setPinning] = useState(false);
  const [recordName, setRecordName] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  // ── Drag-to-resize width ─────────────────────────────────────────────────
  const [drawerWidth, setDrawerWidth] = useState<number>(() => clampDrawerWidth(loadSavedDrawerWidth()));
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Re-clamp width when viewport resizes (e.g., user shrinks browser)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      setDrawerWidth((w) => {
        const next = clampDrawerWidth(w);
        return next === w ? w : next;
      });
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  const handleResizeStart = (clientX: number) => {
    resizeStartRef.current = { startX: clientX, startWidth: drawerWidth };
    setIsResizing(true);
  };

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent | TouchEvent) => {
      const st = resizeStartRef.current;
      if (!st) return;
      const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
      if (clientX == null) return;
      // Drawer is on the right — moving handle LEFT should widen it.
      const delta = st.startX - clientX;
      const next = clampDrawerWidth(st.startWidth + delta);
      setDrawerWidth(next);
    };
    const onUp = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
      saveDrawerWidth(drawerWidth);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isResizing, drawerWidth]);

  // ── Breadcrumb history (drill-down trail within the drawer) ──────────────
  const [history, setHistory] = useState<string[]>([target]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const internalNavRef = useRef(false);

  // When the external target changes, either we initiated it (internalNavRef)
  // or the user picked a different record from the table — reset history.
  useEffect(() => {
    if (internalNavRef.current) {
      internalNavRef.current = false;
      return;
    }
    setHistory([target]);
    setHistoryIndex(0);
    setRecordName(null);
    setExpanded(false);
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNavigate = (t: string) => {
    internalNavRef.current = true;
    setHistory((prev) => [...prev.slice(0, historyIndex + 1), t]);
    setHistoryIndex((i) => i + 1);
    onNavigate(t);
  };

  const handleBack = () => {
    if (historyIndex === 0) return;
    const newIndex = historyIndex - 1;
    internalNavRef.current = true;
    setHistoryIndex(newIndex);
    onNavigate(history[newIndex]);
  };

  const handleForward = () => {
    if (historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    internalNavRef.current = true;
    setHistoryIndex(newIndex);
    onNavigate(history[newIndex]);
  };

  // ── Table record pager (prev/next within the table list) ─────────────────
  const tableIndex = tableRecordTargets ? tableRecordTargets.indexOf(target) : -1;
  const tableTotal = tableRecordTargets?.length ?? 0;
  const showPager = tableIndex !== -1 && tableTotal > 1;

  const handlePrevRecord = () => {
    if (!tableRecordTargets || tableIndex <= 0) return;
    onNavigate(tableRecordTargets[tableIndex - 1]);
  };

  const handleNextRecord = () => {
    if (!tableRecordTargets || tableIndex >= tableTotal - 1) return;
    onNavigate(tableRecordTargets[tableIndex + 1]);
  };

  // J/K keyboard shortcuts for table record paging (skip if focus is in a text input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      if (isEditable || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' || e.key === 'J') { e.preventDefault(); handleNextRecord(); }
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); handlePrevRecord(); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }); // re-bind on every render so closures see latest tableIndex

  // ── Display name resolution ──────────────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    // Resolve display name using the parent scope's _displayField DEF,
    // falling back to value.name, then formatted ID.
    const parentScope = target.split('.').slice(0, -1).join('.');

    Promise.all([
      horizon(target),
      parentScope ? getState(parentScope) : Promise.resolve(null),
    ])
      .then(([result, parentState]) => {
        if (cancelled) return;
        if (!result || Array.isArray(result) || !result.figure) return;
        const value = result.figure.value;
        if (!value) return;

        // 1. Parent's _displayField → pull that field from record's fields
        const df = parentState?.value?._displayField;
        if (df && value.fields) {
          const fieldVal = value.fields[df];
          if (fieldVal != null) { setRecordName(String(fieldVal)); return; }
        }
        // 2. Explicit name on the record
        if (value.name) { setRecordName(value.name); }
      })
      .catch(() => { /* header falls back to formatted ID */ });
    return () => { cancelled = true; };
  }, [ready, target, horizon, getState]);

  const displayName = recordName || formatName(target.split('.').pop() || '');
  const entityType = getEntityType(target);
  const entityId = getEntityId(target);

  // ── Pin to tabs ──────────────────────────────────────────────────────────
  // Promote the currently-open record to a persistent 'record' slice tab in
  // the main tabs area, so it sits next to grid/schema tabs.
  async function handlePinToTabs() {
    if (pinning) return;
    const parentScope = target.split('.').slice(0, -1).join('.');
    if (!parentScope) return;
    setPinning(true);
    try {
      const sliceId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      const now = new Date().toISOString();
      const config: TableSliceConfig = {
        columnOrder: [],
        columnWidths: {},
        hiddenColumns: [],
        sorts: [],
        filters: [],
        filterConjunction: 'AND',
        showLastUpdated: false,
        recordTarget: target,
      };
      const createdBy = userId ?? 'user';
      const sliceName = displayName || formatName(entityId);
      await dispatch({
        op: 'INS',
        target: `${parentScope}._slices.${sliceId}`,
        operand: {
          name: sliceName,
          sliceType: 'record',
          config,
          visibility: 'private',
          createdBy,
          createdAt: now,
          updatedAt: now,
        },
        agent: `user:${createdBy}`,
        ts: now,
        acquired_ts: now,
        client_event_id: crypto.randomUUID(),
      });
      const saved: SavedSlice = {
        id: sliceId,
        name: sliceName,
        scope: parentScope,
        sliceType: 'record',
        config,
        visibility: 'private',
        createdBy,
        createdAt: now,
        updatedAt: now,
      };
      registerSavedSlices([saved]);
      sliceStore.activateSlice(parentScope, saved);
      onClose();
    } catch (err) {
      console.error('[RecordDetailDrawer] pin to tabs failed', err);
    } finally {
      setPinning(false);
    }
  }
  const initials = getInitials(displayName);
  const typeColor = TYPE_COLORS[entityType] || '#7a756d';
  const isFullModal = !isMobile && layoutType === 'modal';
  const isExpandedDrawer = expanded && !isMobile && !isFullModal;
  const canBack = historyIndex > 0;
  const canForward = historyIndex < history.length - 1;

  const panelStyle: React.CSSProperties = isFullModal
    ? {
        ...s.panel,
        position: 'fixed' as const,
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '90vw',
        maxWidth: 1100,
        height: '85vh',
        borderRadius: 12,
        borderLeft: 'none',
        border: `1px solid ${theme.border}`,
        boxShadow: `0 8px 30px ${theme.shadow}`,
        zIndex: 1001,
      }
    : isExpandedDrawer
    ? {
        ...s.panel,
        position: 'fixed' as const,
        inset: 0,
        width: '100vw',
        maxWidth: '100vw',
        height: '100vh',
        borderLeft: 'none',
        borderRadius: 0,
        zIndex: 1001,
      }
    : {
        ...s.panel,
        ...(isMobile ? {
          width: '100vw', maxWidth: '100vw',
          position: 'fixed' as const, inset: 0, zIndex: 1000,
          borderLeft: 'none',
        } : {
          width: drawerWidth,
          maxWidth: 'none',
          position: 'relative' as const,
        }),
      };
  const showResizeHandle = !isMobile && !isFullModal && !isExpandedDrawer;

  return (
    <>
      {(isFullModal || isExpandedDrawer) && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 1000,
          }}
          onClick={isExpandedDrawer ? () => setExpanded(false) : onClose}
        />
      )}
      <div style={panelStyle}>
        {showResizeHandle && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize detail panel"
            onMouseDown={(e) => { e.preventDefault(); handleResizeStart(e.clientX); }}
            onTouchStart={(e) => { if (e.touches[0]) handleResizeStart(e.touches[0].clientX); }}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 0,
              width: 6,
              cursor: 'col-resize',
              zIndex: 5,
              background: isResizing ? `${theme.accent}40` : 'transparent',
              transition: 'background 0.15s',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = `${theme.accent}25`; }}
            onMouseLeave={(e) => { if (!isResizing) (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
          />
        )}
        <div style={s.header}>
          {isMobile && (
            <button onClick={onClose} style={s.backBtn}>{'\u2190'} Back</button>
          )}
          <div style={s.headerContent}>
            <div style={{ ...s.avatar, background: `${typeColor}20`, color: typeColor }}>
              {initials}
            </div>
            <div style={s.headerInfo}>
              <div style={s.headerName}>{displayName}</div>
              <div style={s.headerMeta}>
                <span style={{ ...s.typeBadge, background: `${typeColor}15`, color: typeColor }}>
                  <span style={{ ...s.typeDot, background: typeColor }} />
                  {entityType}
                </span>
                <span style={s.entityIdLabel}>{entityId}</span>
              </div>
            </div>
          </div>
          {/* Table record pager — top-right, visible when browsing a table list */}
          {showPager && !isMobile && (
            <div style={s.pager}>
              <button
                onClick={handlePrevRecord}
                disabled={tableIndex <= 0}
                style={{ ...s.pagerBtn, opacity: tableIndex <= 0 ? 0.3 : 1 }}
                title="Previous record (K)"
              >
                &#8593;
              </button>
              <span style={s.pagerLabel}>{tableIndex + 1} / {tableTotal}</span>
              <button
                onClick={handleNextRecord}
                disabled={tableIndex >= tableTotal - 1}
                style={{ ...s.pagerBtn, opacity: tableIndex >= tableTotal - 1 ? 0.3 : 1 }}
                title="Next record (J)"
              >
                &#8595;
              </button>
            </div>
          )}
          <button
            onClick={handlePinToTabs}
            disabled={pinning}
            style={{
              ...s.expandBtn,
              opacity: pinning ? 0.4 : 1,
              cursor: pinning ? 'default' : 'pointer',
            }}
            title="Pin as a tab in the main area"
            aria-label="Pin to tabs"
          >
            {'\u{1F4CC}'}
          </button>
          {!isMobile && !isFullModal && (
            <button
              onClick={() => setExpanded(e => !e)}
              style={s.expandBtn}
              title={expanded ? 'Collapse' : 'Expand to full screen'}
              aria-label={expanded ? 'Collapse' : 'Expand'}
            >
              {expanded ? '\u229F' : '\u229E'}
            </button>
          )}
          {!isMobile && !isFullModal && !expanded && onCollapse && (
            <button
              onClick={onCollapse}
              style={s.expandBtn}
              title="Collapse panel (keeps record selected)"
              aria-label="Collapse panel"
            >
              {'\u00BB'}
            </button>
          )}
          {!isMobile && <button onClick={onClose} style={s.closeBtn}>&times;</button>}
        </div>

        {/* Breadcrumb bar — drill-down trail, shown only after navigating within the drawer */}
        {history.length > 1 && (
          <div style={s.breadcrumbBar}>
            <button
              onClick={handleBack}
              disabled={!canBack}
              style={{ ...s.navBtn, opacity: canBack ? 1 : 0.3 }}
              title="Go back"
            >
              &#8592;
            </button>
            <div style={s.breadcrumbs}>
              {history.map((h, i) => {
                const label = formatName(getEntityId(h));
                const isCurrent = i === historyIndex;
                return (
                  <span key={i} style={s.breadcrumbItem}>
                    {i > 0 && <span style={s.breadcrumbSep}>/</span>}
                    <button
                      onClick={() => {
                        if (isCurrent) return;
                        internalNavRef.current = true;
                        setHistoryIndex(i);
                        onNavigate(h);
                      }}
                      style={{
                        ...s.breadcrumbBtn,
                        ...(isCurrent ? s.breadcrumbBtnActive : {}),
                      }}
                    >
                      {label}
                    </button>
                  </span>
                );
              })}
            </div>
            <button
              onClick={handleForward}
              disabled={!canForward}
              style={{ ...s.navBtn, opacity: canForward ? 1 : 0.3 }}
              title="Go forward"
            >
              &#8594;
            </button>
          </div>
        )}

        <div style={s.body}>
          <RecordView target={target} onNavigate={handleNavigate} profileFields={profileFields} />
        </div>
      </div>
    </>
  );
}

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    panel: {
      width: 640,
      maxWidth: '55vw',
      minWidth: 320,
      height: '100%',
      flexShrink: 0,
      background: t.bg,
      borderLeft: `1px solid ${t.border}`,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    },
    header: {
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      padding: '20px 24px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
      gap: 12,
    },
    headerContent: {
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      flex: 1,
      minWidth: 0,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: '50%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 15,
      fontWeight: 600,
      flexShrink: 0,
    },
    headerInfo: {
      flex: 1,
      minWidth: 0,
    },
    headerName: {
      fontFamily: "'Source Serif 4', Georgia, serif",
      fontSize: 20,
      fontWeight: 600,
      color: t.textHeading,
      lineHeight: 1.2,
    },
    headerMeta: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginTop: 4,
    },
    typeBadge: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 10,
      fontWeight: 500,
    },
    typeDot: {
      width: 6,
      height: 6,
      borderRadius: '50%',
    },
    entityIdLabel: {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      color: t.textMuted,
    },
    // Table record pager (top-right of header)
    pager: {
      display: 'flex',
      alignItems: 'center',
      gap: 2,
      flexShrink: 0,
    },
    pagerBtn: {
      background: 'none',
      border: `1px solid ${t.border}`,
      borderRadius: 4,
      width: 26,
      height: 26,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 12,
      color: t.textSecondary,
      cursor: 'pointer',
      lineHeight: 1,
      padding: 0,
    },
    pagerLabel: {
      fontSize: 11,
      color: t.textMuted,
      fontVariantNumeric: 'tabular-nums',
      minWidth: 36,
      textAlign: 'center' as const,
      userSelect: 'none' as const,
    },
    backBtn: {
      background: 'none',
      border: 'none',
      fontSize: 13,
      fontWeight: 500,
      color: t.accent,
      cursor: 'pointer',
      padding: '4px 8px',
    },
    expandBtn: {
      background: 'none',
      border: 'none',
      fontSize: 16,
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
      flexShrink: 0,
    },
    closeBtn: {
      background: 'none',
      border: 'none',
      fontSize: 22,
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '0 4px',
      lineHeight: 1,
      flexShrink: 0,
    },
    // Breadcrumb bar (below header, drill-down trail)
    breadcrumbBar: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '6px 16px',
      borderBottom: `1px solid ${t.border}`,
      background: t.bg,
      flexShrink: 0,
    },
    breadcrumbs: {
      display: 'flex',
      alignItems: 'center',
      flex: 1,
      minWidth: 0,
      overflow: 'hidden',
    },
    breadcrumbItem: {
      display: 'inline-flex',
      alignItems: 'center',
    },
    breadcrumbSep: {
      color: t.textMuted,
      fontSize: 11,
      margin: '0 3px',
      userSelect: 'none' as const,
    },
    breadcrumbBtn: {
      background: 'none',
      border: 'none',
      padding: '1px 4px',
      fontSize: 11,
      color: t.textSecondary,
      cursor: 'pointer',
      borderRadius: 4,
      fontFamily: "'JetBrains Mono', monospace",
      whiteSpace: 'nowrap' as const,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: 120,
    },
    breadcrumbBtnActive: {
      color: t.textHeading,
      fontWeight: 600,
      cursor: 'default',
    },
    navBtn: {
      background: 'none',
      border: 'none',
      fontSize: 14,
      color: t.textSecondary,
      cursor: 'pointer',
      padding: '2px 6px',
      borderRadius: 4,
      flexShrink: 0,
      lineHeight: 1,
    },
    body: {
      flex: 1,
      overflowY: 'auto',
      overflowX: 'hidden',
    },
  };
}
