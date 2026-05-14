import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import type { EoState } from '../db/types';
import { useEoStore } from '../store/eo-store';
import { deriveColumns, buildFieldNameMap, buildFieldNameMapFromSchema, hasFieldsSubObject, getFieldValue, applyFilters, type ColumnDef, type FilterRule } from './filter-types';
import { type TimeScrubberFilter, applyTimeScrubber } from './time-scrubber-utils';
import { useTheme, type Theme } from '../theme';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { TypeSelector, TypeBadge } from './TypeSelector';
import { RedactedCell, LockIcon, LockedCell } from './RedactedCell';
import { FilterBar } from './FilterBar';
import { SortPanel, type SortRule } from './SortPanel';
import type { ResolvedPermissions } from '../permissions/types';
import { syncEditToAirtable } from '../ingestion/airtable-writeback';
import { useAirtableStore, createAirtableClient } from '../ingestion/airtable-store';
import { hydrationSync, type SyncCustomization } from '../ingestion/airtable-sync';
import { runAirtableSync, SyncBusyError } from '../ingestion/airtable-sync-runner';
import { createImportProgressListener } from '../store/eo-store';
import { useSliceStore } from '../store/slice-store';
import { defaultColumnWidth, MIN_COLUMN_WIDTH } from './slice-types';
import { formatName } from './scope-picker-utils';
import { useIdResolver, isEntityId, isEntityIdArray, type IdResolver } from '../hooks/useIdResolver';
import { groupSchemaStates, extractColumnTypeOverrides, schemaTypeTarget, schemaConstraintTarget, schemaResolveTarget, type FieldSchema } from '../db/schema-rules';
import { isDeleted } from '../db/tombstone';
import { safeUrl } from '../lib/safe-url';
import { ColumnTypeSelector, COLUMN_TYPE_ICON_MAP } from './ColumnTypeSelector';
import { ResolutionPolicyComposer, summarizePolicy, normalizeResolvePolicy, type ResolvePolicy } from './ResolutionPolicyComposer';
import { buildNulClearingEvent, buildMakingDefEvent } from './cell-events';
import { ConstraintComposer } from './ConstraintComposer';
import { useIsMobile, useIsNarrow } from '../hooks/useIsMobile';
import { ColumnManagerPanel } from './ColumnManagerPanel';
import { AddColumnDialog } from './AddColumnDialog';
import { SchemaFieldPanel, type FieldValueStats } from './SchemaFieldPanel';
import { WatchedFieldsPicker } from './WatchedFieldsPicker';
import { LinkFieldPicker } from './LinkFieldPicker';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface TableViewProps {
  scope: string;
  onSelectRecord: (target: string) => void;
  onViewHistory?: (target: string) => void;
  onEmptyScope?: (parentScope: string) => void;
  activeRecord?: string | null;
  session: { userId: string };
  timeScrubberFilter?: TimeScrubberFilter;
  permissions?: ResolvedPermissions | null;
  /** When true, the current slice is read-only for this user's type */
  sliceReadOnly?: boolean;
  /** Called whenever the visible (filtered+sorted) record list changes. */
  onVisibleRecordTargets?: (targets: string[]) => void;
}

function formatRelativeTime(ts: string): string {
  const now = Date.now();
  const then = new Date(ts).getTime();
  const diff = now - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Common name-like field keys to probe when `value.name` is not set.
// Matches are case-insensitive and cover typical CSV/spreadsheet headers
// ("Name", "Client Name", "Title", etc.). Ordered by preference.
const NAME_LIKE_KEYS = [
  'name',
  'display_name', 'displayname', 'display name',
  'full_name', 'fullname', 'full name',
  'client_name', 'client name', 'client',
  'company_name', 'company name', 'company',
  'title',
  'label',
  'subject',
];

export function resolveRecordName(rec: EoState): string | null {
  const v = rec.value;
  if (!v || typeof v !== 'object') return null;

  // Top-level `name` wins.
  if (typeof v.name === 'string' && v.name) return v.name;

  // Build a case-insensitive key lookup across top-level and `fields` sub-object.
  const sources: Record<string, any>[] = [];
  if (typeof v === 'object' && !Array.isArray(v)) sources.push(v as Record<string, any>);
  if (v.fields && typeof v.fields === 'object' && !Array.isArray(v.fields)) {
    sources.push(v.fields as Record<string, any>);
  }

  for (const source of sources) {
    const lowerMap = new Map<string, any>();
    for (const [k, val] of Object.entries(source)) {
      if (k.startsWith('_')) continue;
      lowerMap.set(k.toLowerCase(), val);
    }
    for (const candidate of NAME_LIKE_KEYS) {
      const val = lowerMap.get(candidate);
      if (typeof val === 'string' && val) return val;
    }
  }

  return null;
}

function formatScopeName(scope: string): string {
  const last = scope.split('.').pop() || scope;
  let name = last.replace(/^(tbl|rec|fld)/, '');
  name = name.replace(/([a-z])([A-Z])/g, '$1 $2');
  return name || last;
}

type TableSyncPhase =
  | { phase: 'idle' }
  | { phase: 'syncing'; message: string }
  | { phase: 'done'; message: string }
  | { phase: 'error'; message: string };

function AirtableSyncTableButton({
  connected,
  isSyncing,
  syncState,
  onSync,
  isMobile,
  theme,
}: {
  connected: boolean;
  isSyncing: boolean;
  syncState: TableSyncPhase;
  onSync: () => void;
  isMobile: boolean;
  theme: Theme;
}) {
  const disabled = !connected || isSyncing;
  const title = !connected
    ? 'Connect Airtable in Settings to enable syncing'
    : isSyncing
      ? (syncState.phase === 'syncing' ? syncState.message : 'A sync is already running')
      : syncState.phase === 'done'
        ? `Last run: ${syncState.message} — click to sync again`
        : syncState.phase === 'error'
          ? `Last error: ${syncState.message} — click to retry`
          : 'Pull fresh records from Airtable into this table';

  const label = isSyncing
    ? (isMobile ? 'Syncing' : 'Syncing…')
    : (isMobile ? 'Sync' : 'Sync from Airtable');

  const stateColor =
    syncState.phase === 'error' ? (theme.dangerText ?? theme.danger ?? '#d04')
    : syncState.phase === 'done' ? (theme.successText ?? theme.success ?? '#2a7')
    : theme.textMuted;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={onSync}
        disabled={disabled}
        title={title}
        aria-label="Sync from Airtable"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: isMobile ? '0 10px' : '0 12px',
          fontSize: isMobile ? 11 : 12,
          fontWeight: 500,
          border: `1px solid ${theme.border}`,
          borderRadius: 6,
          background: theme.bgCard ?? 'transparent',
          color: disabled ? theme.textMuted : theme.text,
          cursor: disabled ? 'not-allowed' : 'pointer',
          whiteSpace: 'nowrap' as const,
          opacity: disabled && !isSyncing ? 0.6 : 1,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isSyncing ? (theme.successText ?? theme.success ?? '#2a7') : stateColor,
            animation: isSyncing ? 'eo-tableview-sync-pulse 1.2s infinite' : undefined,
          }}
        />
        {label}
      </button>
      {!isMobile && syncState.phase !== 'idle' && !isSyncing && (
        <span style={{ fontSize: 11, color: stateColor, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {syncState.message}
        </span>
      )}
      <style>{`
        @keyframes eo-tableview-sync-pulse {
          0%   { box-shadow: 0 0 0 0 rgba(42, 170, 120, 0.6); }
          70%  { box-shadow: 0 0 0 5px rgba(42, 170, 120, 0); }
          100% { box-shadow: 0 0 0 0 rgba(42, 170, 120, 0); }
        }
      `}</style>
    </span>
  );
}

// Absence — the field was never asserted. Render very quietly so the eye
// skips over it; grid lines already confirm the cell exists.
function AbsentCell({ t }: { t: Theme }) {
  return (
    <span
      aria-label="empty"
      style={{ color: t.textMuted, opacity: 0.25, fontSize: '0.85em', userSelect: 'none' }}
    >
      {'\u2014'}
    </span>
  );
}

// Intentionally-cleared — an explicit NULL assertion. Distinct from absence:
// someone deliberately cleared this field. Uses the Unicode "symbol for null"
// (U+2400) so it reads as a deliberate mark, not just empty text.
function ClearedCell({ t }: { t: Theme }) {
  return (
    <span
      aria-label="cleared"
      title="Intentionally cleared"
      style={{
        color: t.textMuted,
        opacity: 0.5,
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '0.9em',
        userSelect: 'none',
      }}
    >
      {'\u2400'}
    </span>
  );
}

// Back-compat shim
function NullCell({ t }: { t: Theme }) {
  return <AbsentCell t={t} />;
}

function humanizeLabel(s: string): string {
  return s
    .split(/[_-]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function getStatusPillStyle(value: string, t: Theme): { bg: string; color: string; border: string } {
  const known: Record<string, { bg: string; color: string; border: string }> = {
    active: t.statusActive,
    archived: t.statusArchived,
    pending: t.statusPending,
  };
  if (known[value]) return known[value];
  const v = value.toLowerCase();
  if (/review|conflict|warn|flag/.test(v)) return { bg: t.warningBg, color: t.warningText, border: t.warningBorder };
  if (/error|fail|denied|blocked|reject/.test(v)) return { bg: t.dangerBg, color: t.dangerText, border: t.dangerBorder };
  if (/closed|done|complete|resolved|archiv/.test(v)) return t.statusArchived;
  if (/upcoming|scheduled|planned|briefing|prep|draft/.test(v)) return { bg: t.purpleBg, color: t.purple, border: t.purpleBorder };
  return { bg: t.bgMuted, color: t.textSecondary, border: t.border };
}

function StatusPill({ value, t }: { value: string; t: Theme }) {
  const sc = getStatusPillStyle(value, t);
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 10px',
      borderRadius: 9999,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: 1.4,
      background: sc.bg,
      color: sc.color,
      border: `1px solid ${sc.border}`,
      whiteSpace: 'nowrap',
    }}>
      {humanizeLabel(value)}
    </span>
  );
}

function IdChip({ value, t, resolved, onNavigate }: {
  value: string;
  t: Theme;
  resolved?: { target: string; name: string | null } | null;
  onNavigate?: (target: string) => void;
}) {
  const clickable = !!(resolved?.target && onNavigate);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 11,
        fontFamily: "'JetBrains Mono', monospace",
        background: t.bgMuted,
        color: clickable ? t.purple : t.textSecondary,
        border: `1px solid ${t.borderLight}`,
        marginRight: 4,
        whiteSpace: 'nowrap',
        cursor: clickable ? 'pointer' : 'default',
      }}
      onClick={clickable ? (e) => { e.stopPropagation(); onNavigate!(resolved!.target); } : undefined}
    >
      {value}
      {resolved?.name && (
        <span style={{ fontFamily: 'inherit', color: t.text, fontWeight: 400 }}>{' · '}{resolved.name}</span>
      )}
    </span>
  );
}

function isCurrencyKey(key: string): boolean {
  return /^(amount|price|cost|fee|total|subtotal|balance|rate|value)(_|$)/i.test(key)
    || /^(amount|price|cost|fee|total|subtotal|balance|rate)$/i.test(key);
}

function isIdArrayValue(value: any): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((v) => typeof v === 'string' && /^[A-Z]{2,5}-\d+$/.test(v));
}

function formatCurrency(n: number): string {
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function renderCell(value: any, key: string, onNavigate: (t: string) => void, t: Theme, resolver?: IdResolver, colType?: string): React.ReactNode {
  // Parse JSON-stringified arrays/objects stored as strings
  if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
    try { const p = JSON.parse(value); if (Array.isArray(p)) value = p; } catch { /* keep as string */ }
  }
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    try { const p = JSON.parse(value); if (p && typeof p === 'object' && !Array.isArray(p)) value = p; } catch { /* keep as string */ }
  }

  // Intentional clear: an explicit null assertion gets the NUL glyph.
  if (value === null) {
    return <ClearedCell t={t} />;
  }

  // Computed/EVA fields with no ingested value
  if ((value === undefined || value === '') && (
    colType === 'formula' || colType === 'rollup' || colType === 'lookup' || colType === 'count'
  )) {
    return <span style={{ color: t.textMuted, fontStyle: 'italic', fontSize: 11 }}>(computed)</span>;
  }

  // Absence: undefined or empty string — never asserted. Show a faint em-dash.
  if (value === undefined || value === '') {
    return <AbsentCell t={t} />;
  }

  // ─── Type-aware rendering ──────────────────────────────────
  if (colType === 'rating' && typeof value === 'number') {
    const max = 5;
    return (
      <span style={{ letterSpacing: 2, fontSize: 13 }}>
        {'★'.repeat(Math.min(value, max))}{'☆'.repeat(Math.max(0, max - value))}
      </span>
    );
  }
  if (colType === 'percent' && typeof value === 'number') {
    return (
      <span style={{ display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {(value * 100).toFixed(1)}%
      </span>
    );
  }
  if (colType === 'currency' && typeof value === 'number') {
    return (
      <span style={{ display: 'block', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        {formatCurrency(value)}
      </span>
    );
  }
  if (colType === 'duration' && typeof value === 'number') {
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = Math.round(value % 60);
    const parts: string[] = [];
    if (h) parts.push(`${h}h`);
    if (m || h) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{parts.join(' ')}</span>;
  }
  if (colType === 'url' && typeof value === 'string') {
    const href = safeUrl(value, ['http:', 'https:']);
    let display: string;
    try { display = new URL(value).hostname; } catch { display = value.slice(0, 40); }
    if (!href) return <span style={{ color: t.textMuted }}>{display}</span>;
    return <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: t.accent }} onClick={(e) => e.stopPropagation()}>{display}</a>;
  }
  if (colType === 'email' && typeof value === 'string') {
    const href = safeUrl(`mailto:${value}`, ['mailto:']);
    if (!href) return <span>{value}</span>;
    return <a href={href} style={{ color: t.accent }} onClick={(e) => e.stopPropagation()}>{value}</a>;
  }
  if (colType === 'phone' && typeof value === 'string') {
    const href = safeUrl(`tel:${value}`, ['tel:']);
    if (!href) return <span>{value}</span>;
    return <a href={href} style={{ color: t.accent }} onClick={(e) => e.stopPropagation()}>{value}</a>;
  }
  if (colType === 'autoNumber' && (typeof value === 'number' || typeof value === 'string')) {
    return <span style={{ fontVariantNumeric: 'tabular-nums', color: t.textMuted }}>#{value}</span>;
  }
  if ((colType === 'createdTime' || colType === 'lastModifiedTime') && typeof value === 'string') {
    try {
      return <span>{new Date(value).toLocaleString()}</span>;
    } catch { /* fall through */ }
  }
  if ((colType === 'lastModifiedBy' || colType === 'createdBy' || colType === 'collaborator') && typeof value === 'object' && value !== null) {
    const display = (value as any).name || (value as any).id || '?';
    return <span>{display}</span>;
  }
  if (colType === 'collaborators' && Array.isArray(value)) {
    const names = (value as any[]).map((c) => c?.name || c?.id || '?');
    return <span>{names.join(', ')}</span>;
  }
  if (colType === 'attachment' && Array.isArray(value)) {
    return <span style={{ color: t.textMuted }}>{value.length} file{value.length !== 1 ? 's' : ''}</span>;
  }
  if (colType === 'multiSelect' && Array.isArray(value)) {
    const names = value.map((v: any) => typeof v === 'object' && v?.name ? v.name : String(v));
    return <span>{names.join(', ')}</span>;
  }
  if (colType === 'select' && typeof value === 'object' && value?.name) {
    return <span>{value.name}</span>;
  }

  // ─── Airtable-style linked record pills ────────────────────
  if (colType === 'link' || colType === 'linkedRecord' || colType === 'relationship') {
    // Extract linked IDs from all possible value shapes
    const ids: string[] = [];
    if (typeof value === 'object' && value !== null && Array.isArray(value?.linked)) {
      ids.push(...value.linked);
    } else if (Array.isArray(value)) {
      ids.push(...value.filter((v: any) => typeof v === 'string'));
    } else if (typeof value === 'string' && value) {
      ids.push(value);
    }

    if (ids.length === 0) return <AbsentCell t={t} />;

    return (
      <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', maxWidth: '100%' }}>
        {ids.map((id) => {
          const shortId = id.includes('.') ? (id.split('.').pop() || id) : id;
          const resolved = id.includes('.')
            ? resolver?.resolveTarget(id)
            : resolver?.resolve(id);
          const displayName = resolved?.name || null;
          const navTarget = resolved?.target || id;
          return (
            <span
              key={id}
              onClick={(e) => { e.stopPropagation(); onNavigate(navTarget); }}
              onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLElement;
                el.style.background = t.purple;
                el.style.color = '#fff';
                el.style.borderColor = t.purple;
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLElement;
                el.style.background = t.purpleBg;
                el.style.color = t.purple;
                el.style.borderColor = t.purpleBorder;
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: '2px 9px',
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 500,
                lineHeight: 1.4,
                background: t.purpleBg,
                border: `1px solid ${t.purpleBorder}`,
                color: t.purple,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                transition: 'background 0.12s, color 0.12s, border-color 0.12s',
              }}
              title={displayName ? `${displayName} (${shortId})` : shortId}
            >
              {displayName || shortId}
            </span>
          );
        })}
      </span>
    );
  }

  // Status pill — universal for any string value on the status column
  if (key === 'status' && typeof value === 'string') {
    return <StatusPill value={value} t={t} />;
  }

  // Linked objects (CON)
  if (typeof value === 'object' && value !== null && value.linked && Array.isArray(value.linked)) {
    return (
      <span>
        {value.linked.map((target: string, i: number) => {
          const resolved = resolver?.resolveTarget(target);
          const shortId = target.split('.').pop() || target;
          return (
            <span key={target}>
              {i > 0 && ', '}
              <span
                style={{ color: t.purple, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: t.purpleBorder }}
                onClick={(e) => { e.stopPropagation(); onNavigate(target); }}
              >
                {shortId}
                {resolved?.name && <span style={{ textDecoration: 'none', color: t.text }}>{' · '}{resolved.name}</span>}
              </span>
            </span>
          );
        })}
      </span>
    );
  }

  // Arrays of ID-shaped strings (e.g. ["ATT-005", "ATT-003"]) — render as chips
  if (isIdArrayValue(value)) {
    return (
      <span>
        {value.map((id) => <IdChip key={id} value={id} t={t} resolved={resolver?.resolve(id)} onNavigate={onNavigate} />)}
      </span>
    );
  }

  // Single ID-shaped string (e.g. "ATT-006") — render as chip for consistency
  if (typeof value === 'string' && /^[A-Z]{2,5}-\d+$/.test(value)) {
    return <IdChip value={value} t={t} resolved={resolver?.resolve(value)} onNavigate={onNavigate} />;
  }

  // Arrays of target-path strings (e.g. ["import.cases.CASE-001", "import.cases.CASE-003"]) — render as clickable links
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.includes('.'))) {
    return (
      <span>
        {value.map((target: string, i: number) => {
          const resolved = resolver?.resolveTarget(target);
          const shortId = target.split('.').pop() || target;
          return (
            <span key={target}>
              {i > 0 && ', '}
              <span
                style={{ color: t.purple, cursor: 'pointer', textDecoration: 'underline', textDecorationColor: t.purpleBorder }}
                onClick={(e) => { e.stopPropagation(); onNavigate(target); }}
              >
                {shortId}
                {resolved?.name && <span style={{ textDecoration: 'none', color: t.text }}>{' · '}{resolved.name}</span>}
              </span>
            </span>
          );
        })}
      </span>
    );
  }

  // Other arrays: comma-joined primitives
  if (Array.isArray(value)) {
    if (value.every((v) => v == null || typeof v !== 'object')) {
      return <span>{value.filter((v) => v != null).join(', ') || <NullCell t={t} />}</span>;
    }
    const json = JSON.stringify(value);
    const display = json.length > 50 ? json.slice(0, 47) + '...' : json;
    return <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>{display}</span>;
  }

  // Other objects
  if (typeof value === 'object' && value !== null) {
    const json = JSON.stringify(value);
    const display = json.length > 50 ? json.slice(0, 47) + '...' : json;
    return <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.textSecondary }}>{display}</span>;
  }

  // Boolean
  if (typeof value === 'boolean') {
    return <span>{value ? 'Yes' : 'No'}</span>;
  }

  // Currency-shaped numeric keys
  if (isCurrencyKey(key)) {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    if (!Number.isNaN(n)) {
      return (
        <span style={{
          display: 'block',
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {formatCurrency(n)}
        </span>
      );
    }
  }

  // Plain numbers — right-align with tabular numerals and thousands separators
  if (typeof value === 'number') {
    return (
      <span style={{
        display: 'block',
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value.toLocaleString('en-US')}
      </span>
    );
  }

  return <span>{String(value)}</span>;
}

export function TableView({ scope, onSelectRecord, onViewHistory, onEmptyScope, activeRecord, session, timeScrubberFilter, permissions, sliceReadOnly, onVisibleRecordTargets }: TableViewProps) {
  const getStateByPrefix = useEoStore((s) => s.getStateByPrefix);
  const getStateByPrefixPage = useEoStore((s) => s.getStateByPrefixPage);
  const getState = useEoStore((s) => s.getState);
  const dispatch = useEoStore((s) => s.dispatch);
  const ready = useEoStore((s) => s.ready);
  const lastSeq = useEoStore((s) => s.lastSeq);

  const scopeRoot = scope.split('.')[0];
  const idResolver = useIdResolver(scopeRoot);

  // Airtable connection state — drives the visibility/enabled-state of the
  // per-table "Sync from Airtable" toolbar button. `isSyncing` is global
  // across all sync paths (continuous tick, AirtableSettings, this button),
  // so any in-flight sync disables the control to avoid colliding with the
  // runner gate.
  const airtableConnected = useAirtableStore((st) => st.connected);
  const airtableApiKey = useAirtableStore((st) => st.apiKey);
  const airtableIsSyncing = useAirtableStore((st) => st.isSyncing);

  // --- Virtual scrolling constants ---
  const ROW_HEIGHT_PX: Record<string, number> = { compact: 32, default: 44, tall: 60 };
  const VIRTUAL_BUFFER = 8;
  // Start virtualizing at 50 rows — keeps DOM small and scrolling smooth even
  // for medium-sized scopes.  Below this threshold all rows render as-is.
  const LARGE_DATASET_THRESHOLD = 50;

  // --- Virtual scroll state ---
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(600);
  // rAF token — ensures scroll handler fires at most once per frame.
  const scrollRafRef = useRef<number | null>(null);

  const [records, setRecords] = useState<EoState[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  // True after the sync stream has gone quiet for a short grace period. Used to
  // suppress the "No records in this scope" message while events are still
  // streaming in from Matrix on a cold load — otherwise the grid paints the
  // empty state prematurely before the fold has produced the records that are
  // already on their way. Resets on scope change and on every lastSeq tick.
  const [emptyStateSettled, setEmptyStateSettled] = useState(false);
  // --- Update indicator state ---
  // isUpdating: true briefly while a sync-triggered re-fetch is in flight.
  // lastUpdate: summary of the most recent non-empty diff (added/modified/removed
  //   record targets). Null until the first observed change.
  // showUpdateDetail: toggles the detail popup listing the changed records.
  const [isUpdating, setIsUpdating] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<{
    added: string[];
    modified: string[];
    removed: string[];
    ts: number;
    // Whether the indicator was just set in this render cycle (for the pulse animation).
    fresh: boolean;
  } | null>(null);
  const [showUpdateDetail, setShowUpdateDetail] = useState(false);
  // Map of target → last_seq for the previous record set, used to compute diffs
  // when a sync-triggered re-fetch replaces the record list.
  const prevRecordsMapRef = useRef<Map<string, number>>(new Map());
  const [fieldNameMap, setFieldNameMap] = useState<Map<string, string>>(new Map());
  const [scopeName, setScopeName] = useState<string | null>(null);
  const [auditableDisplayField, setAuditableDisplayField] = useState<string | null>(null);
  // When this scope was imported from Airtable, the table's DEF event records
  // { base_id, table_id } on `_airtable`. Presence drives the per-table
  // "Sync from Airtable" toolbar button.
  const [airtableSource, setAirtableSource] = useState<{ baseId: string; tableId: string } | null>(null);
  const [tableSyncState, setTableSyncState] = useState<
    | { phase: 'idle' }
    | { phase: 'syncing'; message: string }
    | { phase: 'done'; message: string }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  const [filterText, setFilterText] = useState('');
  // Debounced filter text — used for actual filtering so that typing remains
  // responsive when the record set is large.
  const [debouncedFilterText, setDebouncedFilterText] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: string } | null>(null);
  const [cellContextMenu, setCellContextMenu] = useState<{ x: number; y: number; target: string; fieldKey: string } | null>(null);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number; key: string; label: string } | null>(null);
  const [watchedFieldsPicker, setWatchedFieldsPicker] = useState<{ x: number; y: number; key: string } | null>(null);
  const [renameCol, setRenameCol] = useState<{ key: string; value: string } | null>(null);
  const [typeSelector, setTypeSelector] = useState<{ x: number; y: number; target: string; currentType?: string } | null>(null);
  const [fieldSchemas, setFieldSchemas] = useState<Map<string, FieldSchema>>(new Map());
  const [columnTypeOverrides, setColumnTypeOverrides] = useState<Map<string, any>>(new Map());
  const [columnTypeSelector, setColumnTypeSelector] = useState<{ x: number; y: number; key: string } | null>(null);
  const [linkedRecordPicker, setLinkedRecordPicker] = useState<{ x: number; y: number; key: string; tables: { scope: string; name: string }[]; mode: 'linkedRecord' | 'link' | 'relationship'; selected: string[] } | null>(null);
  const [resolutionComposer, setResolutionComposer] = useState<{ x: number; y: number; key: string } | null>(null);
  const [constraintComposer, setConstraintComposer] = useState<{ x: number; y: number; key: string } | null>(null);
  // Full-field editor side panel — opened by double-clicking a column header.
  const [fieldPanelKey, setFieldPanelKey] = useState<string | null>(null);
  const [editingCell, setEditingCell] = useState<{ target: string; fieldKey: string; value: string } | null>(null);
  const [editingLinkCell, setEditingLinkCell] = useState<{ target: string; fieldKey: string; linkedTables: string[] } | null>(null);
  // Tracks the most recent editable cell a user clicked. A second click on the
  // same cell (while its record is active in the side drawer) enters inline
  // edit mode; this implements the "click once opens drawer, click again edits"
  // interaction.
  const [lastClickedCell, setLastClickedCell] = useState<{ target: string; fieldKey: string } | null>(null);
  const editDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevRecordsKeyRef = useRef<string>('');
  const prevSchemaKeyRef = useRef<string>('');
  const prevScopeNameRef = useRef<string | null>(null);
  const fetchGenRef = useRef(0);
  // Counts consecutive sync re-fetches that returned zero records while the
  // previous snapshot was non-empty. The store can transiently report an empty
  // scope during SYN merges and in-flight fold operations (see comment at
  // `hasCheckedEmptyScopeRef` below); applying those as-is causes the grid to
  // flicker between "loaded" and "No records in this scope" on every sync.
  // Require two consecutive empties before accepting an empty set as truth.
  const emptySyncCountRef = useRef(0);
  // Mirrors `recordsLoaded` for reads inside the paginated initial-load
  // promise chain; state closures go stale across awaits, and we need to
  // know whether the UI has already been unblocked before flipping again.
  const recordsLoadedRef = useRef(false);
  const { theme } = useTheme();
  const s = makeStyles(theme);

  // --- Slice store (SIG) ---
  const sliceStore = useSliceStore();
  const viewConfig = sliceStore.getConfig(scope);
  const sorts = viewConfig.sorts;
  const advancedFilters = viewConfig.filters;
  const filterConjunction = viewConfig.filterConjunction;
  const hiddenColumnsArr = viewConfig.hiddenColumns;
  const typeHiddenFields = permissions?.type_hidden_fields ?? [];
  const hiddenColumns = useMemo(() => {
    const s = new Set(hiddenColumnsArr);
    for (const f of typeHiddenFields) s.add(f);
    return s;
  }, [hiddenColumnsArr, typeHiddenFields]);
  const columnOrder = viewConfig.columnOrder;
  const columnWidths = viewConfig.columnWidths;
  const rowHeight = viewConfig.rowHeight || 'default';
  const cellOverflow = viewConfig.cellOverflow || 'clip';
  const showFieldIds = viewConfig.showFieldIds || false;
  const profileFields = viewConfig.profileFields;
  const displayField = auditableDisplayField ?? viewConfig.displayField ?? null;
  const isMobile = useIsMobile();
  const isNarrow = useIsNarrow();

  const [showProfilePicker, setShowProfilePicker] = useState(false);
  const [showColumnManager, setShowColumnManager] = useState(false);
  const [showAddColumn, setShowAddColumn] = useState(false);

  const setSorts = useCallback((s: SortRule[]) => sliceStore.setSorts(scope, s), [scope, sliceStore]);
  const setAdvancedFilters = useCallback((f: FilterRule[]) => sliceStore.setFilters(scope, f), [scope, sliceStore]);
  const setFilterConjunction = useCallback((c: 'AND' | 'OR') => sliceStore.setFilterConjunction(scope, c), [scope, sliceStore]);
  const setHiddenColumns = useCallback((fn: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const next = typeof fn === 'function' ? fn(hiddenColumns) : fn;
    sliceStore.setHiddenColumns(scope, [...next]);
  }, [scope, sliceStore, hiddenColumns]);

  // --- Column resize state ---
  const [resizing, setResizing] = useState<{ key: string; startX: number; startWidth: number } | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  // --- Row selection state ---
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const toggleRowSelection = useCallback((target: string) => {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(target)) next.delete(target);
      else next.add(target);
      return next;
    });
  }, []);
  const deselectAllRows = useCallback(() => setSelectedRows(new Set()), []);

  // --- DnD sensors (delay-based to prevent accidental drags while resizing) ---
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  const scopeDepth = scope.split('.').length;

  // --- Column resize handlers ---
  useEffect(() => {
    if (!resizing) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - resizing.startX;
      const newWidth = Math.max(MIN_COLUMN_WIDTH, resizing.startWidth + delta);
      sliceStore.setColumnWidth(scope, resizing.key, newWidth);
    };
    const handleMouseUp = () => setResizing(null);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizing, scope, sliceStore]);

  // --- Virtual scroll: track container height ---
  useEffect(() => {
    const el = tableWrapRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    const ro = new ResizeObserver(() => setContainerHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Column drag handlers ---
  function handleColumnDragStart(event: DragStartEvent) {
    setActiveDragId(event.active.id as string);
  }
  function handleColumnDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const currentOrder = orderedColumns.map((c) => c.key);
    const oldIndex = currentOrder.indexOf(active.id as string);
    const newIndex = currentOrder.indexOf(over.id as string);
    if (oldIndex === -1 || newIndex === -1) return;
    const newOrder = arrayMove(currentOrder, oldIndex, newIndex);
    sliceStore.setColumnOrder(scope, newOrder);
  }

  // Load records and field metadata
  useEffect(() => {
    if (!ready) return;
    const gen = ++fetchGenRef.current;

    // Helper to filter raw states down to visible direct-child records.
    // Excludes:
    //   - rows at the wrong depth (sub-targets like `.fields.name`)
    //   - SYN-merged aliases (folded into another record)
    //   - underscore-prefixed system rows (_schema, _slices, ...)
    //   - tombstoned records — soft-deleted via db/tombstone.ts so deletes
    //     from the source-of-truth (e.g. Airtable webhook payloads) take
    //     effect in the grid without hard-removing the event-log history.
    function filterDirect(states: EoState[]): EoState[] {
      return states.filter((st) => {
        const parts = st.target.split('.');
        if (parts.length !== scopeDepth + 1 || st.value?._alias) return false;
        const segment = parts[parts.length - 1];
        if (segment.startsWith('_')) return false;
        if (isDeleted(st)) return false;
        return true;
      });
    }

    // For re-fetches triggered by lastSeq (sync updates), use the non-paged path so
    // we always see a consistent view of the full collection. The fingerprint check
    // below prevents unnecessary React re-renders when nothing changed.
    const isInitialLoad = prevRecordsKeyRef.current === '';

    if (isInitialLoad) {
      // Phase 1: load first 200 records immediately for a fast first paint
      const INITIAL_PAGE = 200;
      const BATCH_SIZE = 500;
      getStateByPrefixPage(scope + '.', INITIAL_PAGE).then(async ({ rows, nextCursor }) => {
        if (gen !== fetchGenRef.current) return;
        const direct = filterDirect(rows);
        prevRecordsKeyRef.current = 'loading'; // mark as started
        setRecords(direct);
        // IDB keys sort lexicographically; `_schema.*` / `_slices.*` sort
        // before regular record ids. A table with a rich schema can fill the
        // entire first page with non-record rows that filterDirect() rejects.
        // `direct.length === 0` is NOT authoritative until `nextCursor` is
        // null — flipping recordsLoaded too early paints a transient "No
        // records in this scope" until the streaming batches hydrate.
        if (direct.length > 0 || nextCursor === null) {
          setRecordsLoaded(true);
        }
        if (import.meta.env.DEV && rows.length > 0 && direct.length === 0 && nextCursor !== null) {
          console.debug('[TableView] initial page yielded 0 visible records of', rows.length, 'for', scope);
        }

        // Phase 2: stream remaining records in background batches
        let cursor = nextCursor;
        let accumulated = direct;
        while (cursor !== null) {
          if (gen !== fetchGenRef.current) return;
          const { rows: more, nextCursor: next } = await getStateByPrefixPage(scope + '.', BATCH_SIZE, cursor);
          if (gen !== fetchGenRef.current) return;
          const moreDirect = filterDirect(more);
          accumulated = [...accumulated, ...moreDirect];
          setRecords(accumulated);
          // Unblock the UI the moment the first non-empty batch arrives.
          if (!recordsLoadedRef.current && accumulated.length > 0) {
            setRecordsLoaded(true);
          }
          cursor = next;
        }
        // Streaming finished — authoritative empty is safe to surface now.
        if (!recordsLoadedRef.current) setRecordsLoaded(true);
        emptySyncCountRef.current = 0;
        // Final fingerprint for future sync-triggered re-fetches
        prevRecordsKeyRef.current = accumulated.map(r => r.target + ':' + r.last_seq).join('|');
        // Seed the target→last_seq map so the first sync re-fetch after initial
        // load can produce a correct diff.
        prevRecordsMapRef.current = new Map(accumulated.map(r => [r.target, r.last_seq]));
      });
    } else {
      // Sync-triggered re-fetch: reload full set but only re-render if something changed.
      // Mark the indicator as in-flight while the fetch is pending so the UI can
      // show a brief "updating" state.
      setIsUpdating(true);
      getStateByPrefix(scope + '.').then((states) => {
        if (gen !== fetchGenRef.current) return;
        const direct = filterDirect(states);
        // Guard against transient empty results: the store can momentarily
        // return zero matches during SYN merges, fold operations, or other
        // in-flight mutations. If the previous snapshot had records, skip the
        // first such empty and wait for the next sync to confirm it. This
        // prevents the grid from flickering to "No records in this scope"
        // on every lastSeq bump.
        if (direct.length === 0 && prevRecordsMapRef.current.size > 0 && emptySyncCountRef.current < 1) {
          emptySyncCountRef.current += 1;
          setIsUpdating(false);
          setRecordsLoaded(true);
          return;
        }
        emptySyncCountRef.current = 0;
        const key = direct.map(r => r.target + ':' + r.last_seq).join('|');
        if (key !== prevRecordsKeyRef.current) {
          // Compute the diff against the previously-observed record set so the
          // user can click through to see exactly what changed.
          const oldMap = prevRecordsMapRef.current;
          const newMap = new Map(direct.map(r => [r.target, r.last_seq]));
          const added: string[] = [];
          const modified: string[] = [];
          const removed: string[] = [];
          for (const [t, seq] of newMap) {
            const prev = oldMap.get(t);
            if (prev === undefined) added.push(t);
            else if (prev !== seq) modified.push(t);
          }
          for (const t of oldMap.keys()) {
            if (!newMap.has(t)) removed.push(t);
          }
          prevRecordsKeyRef.current = key;
          prevRecordsMapRef.current = newMap;
          setRecords(direct);
          if (added.length || modified.length || removed.length) {
            setLastUpdate({ added, modified, removed, ts: Date.now(), fresh: true });
          }
        }
        setIsUpdating(false);
        setRecordsLoaded(true);
      }).catch(() => {
        setIsUpdating(false);
      });
    }

    // Fetch field metadata: prefer per-field schema entities, fall back to array on table state
    getStateByPrefix(scope + '._schema.').then((allSchemaStates) => {
      if (gen !== fetchGenRef.current) return;
      // Only process schema if it actually changed
      const schemaKey = allSchemaStates.map(s => s.target + ':' + s.last_seq).join('|');
      if (schemaKey === prevSchemaKeyRef.current) return;
      prevSchemaKeyRef.current = schemaKey;

      const schemaPrefix = scope + '._schema.';
      // Filter to direct children of _schema only
      const schemaDepth = scope.split('.').length + 2; // scope._schema.fieldId
      const fieldStates = allSchemaStates.filter(
        (st) => st.target.split('.').length === schemaDepth && !st.value?._alias,
      );
      if (fieldStates.length > 0) {
        setFieldNameMap(buildFieldNameMapFromSchema(fieldStates));
      } else {
        // Fallback: read field metadata from table state array
        getState(scope).then((scopeState) => {
          if (gen !== fetchGenRef.current) return;
          const fields = scopeState?.value?.fields;
          if (Array.isArray(fields)) {
            setFieldNameMap(buildFieldNameMap(fields));
          } else {
            setFieldNameMap(new Map());
          }
        });
      }
      // Group all schema states (including .type, .constraint.*, .resolve children) for schema rules
      const grouped = groupSchemaStates(allSchemaStates, schemaPrefix);
      setFieldSchemas(grouped);
      setColumnTypeOverrides(extractColumnTypeOverrides(grouped));
    });
    // Fetch scope display name and auditable display field
    getState(scope).then((scopeState) => {
      if (gen !== fetchGenRef.current) return;
      const name = scopeState?.value?.name ?? null;
      if (name !== prevScopeNameRef.current) {
        prevScopeNameRef.current = name;
        setScopeName(name);
      }
      setAuditableDisplayField(scopeState?.value?._displayField ?? null);
      const at = scopeState?.value?._airtable;
      if (at && typeof at === 'object' && at.type === 'table' && typeof at.base_id === 'string' && typeof at.table_id === 'string') {
        setAirtableSource({ baseId: at.base_id, tableId: at.table_id });
      } else {
        setAirtableSource(null);
      }
    });
  }, [ready, lastSeq, getStateByPrefix, getStateByPrefixPage, getState, scope, scopeDepth]);

  // When scope has no records and no state of its own, navigate up to parent scope.
  // Only check on the FIRST successful load after a scope change — not on every
  // sync-triggered re-fetch, which could see transient empty states (e.g. during
  // SYN merges that temporarily alias all records).
  const hasCheckedEmptyScopeRef = useRef(false);
  useEffect(() => { hasCheckedEmptyScopeRef.current = false; }, [scope]);
  useEffect(() => {
    if (!recordsLoaded || hasCheckedEmptyScopeRef.current) return;
    // Don't navigate away while seq is 0 — the store is still receiving sync
    // and an empty result is transient, not authoritative.
    if (lastSeq === 0) return;
    // Also defer the check while the sync stream is still active, otherwise
    // a cold load that hasn't yet ingested this scope's records would bounce
    // the user to the parent before the records arrive.
    if (!emptyStateSettled) return;
    hasCheckedEmptyScopeRef.current = true;
    if (records.length === 0 && onEmptyScope) {
      // Don't navigate away if the scope itself has state — it's a leaf record
      getState(scope).then((scopeState) => {
        if (scopeState?.value && !scopeState.value._alias) return;
        const parts = scope.split('.');
        if (parts.length > 1) {
          const parentScope = parts.slice(0, -1).join('.');
          onEmptyScope(parentScope);
        }
      });
    }
  }, [records, recordsLoaded, lastSeq, scope, onEmptyScope, getState, emptyStateSettled]);

  // Reset filter and loaded state when scope changes.
  // NOTE: records are NOT cleared here — the stale-fetch guard (fetchGenRef)
  // prevents wrong-scope data, and keeping the old records avoids a flash of
  // "No records in this scope" that could trigger onEmptyScope navigation.
  useEffect(() => {
    setFilterText('');
    setDebouncedFilterText('');
    setRecordsLoaded(false);
    prevRecordsKeyRef.current = '';
    prevSchemaKeyRef.current = '';
    prevScopeNameRef.current = null;
    setAuditableDisplayField(null);
    // Clear update indicator state so switching tables doesn't carry over a
    // stale "updated" badge from the previous scope.
    prevRecordsMapRef.current = new Map();
    emptySyncCountRef.current = 0;
    recordsLoadedRef.current = false;
    setIsUpdating(false);
    setLastUpdate(null);
    setShowUpdateDetail(false);
  }, [scope]);

  // Keep the recordsLoaded ref in sync with state so the async paginator
  // inside the initial-load effect can read it without a stale closure.
  useEffect(() => { recordsLoadedRef.current = recordsLoaded; }, [recordsLoaded]);

  // Delay the "No records in this scope" message until the event stream has
  // been quiet for EMPTY_STATE_SETTLE_MS. Each scope change AND each lastSeq
  // tick resets the timer, so:
  //   - On cold load, while Matrix sync is still ingesting events (lastSeq
  //     ticks frequently), the empty message stays hidden — we render a
  //     neutral "Loading records…" instead of misleadingly claiming the scope
  //     is empty.
  //   - Once the stream settles and records is genuinely empty, the message
  //     surfaces as expected.
  const EMPTY_STATE_SETTLE_MS = 1500;
  useEffect(() => {
    setEmptyStateSettled(false);
    const id = setTimeout(() => setEmptyStateSettled(true), EMPTY_STATE_SETTLE_MS);
    return () => clearTimeout(id);
  }, [scope, lastSeq]);

  // Debounce filterText so that keystroke latency is bounded by a short
  // timer rather than the cost of re-filtering the full record set.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedFilterText(filterText), 150);
    return () => clearTimeout(id);
  }, [filterText]);

  // Clear the `fresh` pulse flag shortly after a new update arrives so the
  // attention-grabbing animation is transient; the badge itself remains so
  // the user can click through to see what changed.
  useEffect(() => {
    if (!lastUpdate?.fresh) return;
    const id = setTimeout(() => {
      setLastUpdate((prev) => (prev ? { ...prev, fresh: false } : prev));
    }, 2500);
    return () => clearTimeout(id);
  }, [lastUpdate?.ts, lastUpdate?.fresh]);

  // Detect if records use the Airtable-style fields sub-object
  const useFieldsSub = useMemo(() => hasFieldsSubObject(records), [records]);

  const entityColumns = useMemo(() => {
    const cols = deriveColumns(records, fieldNameMap, columnTypeOverrides, showFieldIds);
    return cols.map(col => {
      if (col.type === 'select' || col.type === 'multiSelect') {
        const enumConstraint = fieldSchemas.get(col.key)?.constraints.find(c => c.name === 'enum');
        if (enumConstraint?.value?.choices) {
          return { ...col, selectOptions: enumConstraint.value.choices as string[] };
        }
      }
      return col;
    });
  }, [records, fieldNameMap, columnTypeOverrides, showFieldIds, fieldSchemas]);
  const columns = useMemo<ColumnDef[]>(() => {
    const all = [
      { key: '_record', label: 'record', type: 'text' as const },
      ...entityColumns,
      { key: '_last_updated', label: 'last updated', type: 'text' as const },
    ];
    if (hiddenColumns.size === 0) return all;
    return all.filter((col) => !hiddenColumns.has(col.key));
  }, [entityColumns, hiddenColumns]);

  // Apply column ordering from view store
  const orderedColumns = useMemo<ColumnDef[]>(() => {
    if (columnOrder.length === 0) return columns;
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const ordered: ColumnDef[] = [];
    // First add columns in the saved order
    for (const key of columnOrder) {
      const col = byKey.get(key);
      if (col) {
        ordered.push(col);
        byKey.delete(key);
      }
    }
    // Then append any new columns not in the saved order
    for (const col of columns) {
      if (byKey.has(col.key)) ordered.push(col);
    }
    return ordered;
  }, [columns, columnOrder]);

  // Resolve each record's display name once per records change.
  // `resolveRecordName` is expensive (it rebuilds a lowercased-key Map from
  // Object.entries on every call), and it's used both during sort decoration
  // and during _record cell rendering — so without this cache the cost
  // multiplies by filter/sort/render churn.
  const recordNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const rec of records) {
      const name = resolveRecordName(rec);
      if (name) m.set(rec.target, name);
    }
    return m;
  }, [records]);

  const filtered = useMemo(() => {
    let result = records;

    // Text filter
    if (debouncedFilterText) {
      const q = debouncedFilterText.toLowerCase();
      result = result.filter((rec) => {
        const target = rec.target.toLowerCase();
        if (target.includes(q)) return true;
        if (rec.value) {
          const source = useFieldsSub && rec.value.fields && typeof rec.value.fields === 'object'
            ? rec.value.fields
            : rec.value;
          return Object.values(source).some(v =>
            v != null && String(v).toLowerCase().includes(q)
          );
        }
        return false;
      });
    }
    // Advanced filters (FilterBar)
    if (advancedFilters.length > 0) {
      result = applyFilters(result, advancedFilters, filterConjunction, useFieldsSub);
    }
    // Time scrubber filter
    if (timeScrubberFilter) {
      result = applyTimeScrubber(result, timeScrubberFilter, useFieldsSub);
    }

    // Multi-column sort — decorate-sort-undecorate.
    //
    // Previously this was a plain Array.sort((a, b) => …) whose comparator
    // invoked getFieldValue / resolveRecordName on BOTH operands for every
    // pairwise compare.  resolveRecordName in particular is expensive (it
    // builds a lowercased key map via Object.entries on every call), and
    // Array.sort calls the comparator O(N log N) times, so the total cost
    // was O(N log N × expensive-lookup) — which is why clicking into a
    // slice got noticeably slower as the underlying collection grew.
    //
    // Instead, resolve each record's sort key once (O(N)) into a decorated
    // array, sort the decorated array using cheap primitive comparisons
    // (O(N log N × O(1))), then project back.  Total cost becomes
    // O(N × lookup + N log N × primitive compare), which for realistic
    // slice sizes is effectively linear.
    if (sorts.length > 0) {
      type DecoratedRow = {
        rec: EoState;
        keys: { str: string; num: number; isNum: boolean }[];
      };
      const decorated: DecoratedRow[] = result.map((rec) => {
        const keys = sorts.map((sort) => {
          const val = sort.field === '_record'
            ? ((displayField ? getFieldValue(rec, displayField, useFieldsSub) : null) ?? recordNameMap.get(rec.target) ?? rec.target.split('.').pop() ?? '')
            : getFieldValue(rec, sort.field, useFieldsSub);
          const str = val != null ? String(val) : '';
          const num = Number(str);
          const isNum = str !== '' && !isNaN(num);
          return { str, num, isNum };
        });
        return { rec, keys };
      });
      decorated.sort((a, b) => {
        for (let i = 0; i < sorts.length; i++) {
          const ak = a.keys[i];
          const bk = b.keys[i];
          const cmp = (ak.isNum && bk.isNum)
            ? ak.num - bk.num
            : ak.str.localeCompare(bk.str);
          const directed = sorts[i].direction === 'asc' ? cmp : -cmp;
          if (directed !== 0) return directed;
        }
        return 0;
      });
      result = decorated.map((d) => d.rec);
    }
    return result;
  }, [records, debouncedFilterText, useFieldsSub, advancedFilters, filterConjunction, timeScrubberFilter, sorts, displayField, recordNameMap]);

  // Report the visible ordered record targets to the parent whenever the list changes.
  useEffect(() => {
    onVisibleRecordTargets?.(filtered.map((r) => r.target));
  }, [filtered, onVisibleRecordTargets]);

  // --- Row selection helpers derived from `filtered` ---
  const selectAllVisible = useCallback(() => {
    setSelectedRows(new Set(filtered.map((r) => r.target)));
  }, [filtered]);
  const visibleSelectedCount = useMemo(() => {
    if (selectedRows.size === 0) return 0;
    let n = 0;
    for (const r of filtered) if (selectedRows.has(r.target)) n++;
    return n;
  }, [filtered, selectedRows]);
  const allVisibleSelected = filtered.length > 0 && visibleSelectedCount === filtered.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;

  // --- Virtual scroll window ---
  const rowPx = ROW_HEIGHT_PX[rowHeight] ?? 44;
  const useVirtual = filtered.length > LARGE_DATASET_THRESHOLD;
  const virtualStart = useVirtual
    ? Math.max(0, Math.floor(scrollTop / rowPx) - VIRTUAL_BUFFER)
    : 0;
  const virtualEnd = useVirtual
    ? Math.min(filtered.length, Math.ceil((scrollTop + containerHeight) / rowPx) + VIRTUAL_BUFFER)
    : filtered.length;
  const virtualRows = useVirtual ? filtered.slice(virtualStart, virtualEnd) : filtered;
  const spacerTop = virtualStart * rowPx;
  const spacerBottom = (filtered.length - virtualEnd) * rowPx;

  function handleColumnContextMenu(e: React.MouseEvent, col: ColumnDef) {
    e.preventDefault();
    e.stopPropagation();
    setColumnMenu({ x: e.clientX, y: e.clientY, key: col.key, label: col.label });
    setContextMenu(null);
  }

  function getColumnMenuItems(colKey: string, colLabel: string): ContextMenuItem[] {
    const activeSort = sorts.find((s) => s.field === colKey);
    const currentCol = entityColumns.find((c) => c.key === colKey);
    const fs = fieldSchemas.get(colKey);
    const isSystemCol = colKey === '_record' || colKey === '_last_updated';

    const items: ContextMenuItem[] = [
      {
        label: 'Rename column',
        onClick: () => {
          setRenameCol({ key: colKey, value: colLabel });
          setColumnMenu(null);
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: `Sort ascending${activeSort?.direction === 'asc' ? ' (active)' : ''}`,
        onClick: () => setSorts([{ id: crypto.randomUUID(), field: colKey, direction: 'asc' }]),
      },
      {
        label: `Sort descending${activeSort?.direction === 'desc' ? ' (active)' : ''}`,
        onClick: () => setSorts([{ id: crypto.randomUUID(), field: colKey, direction: 'desc' }]),
      },
      ...(activeSort ? [{
        label: 'Remove sort',
        onClick: () => setSorts(sorts.filter((s) => s.field !== colKey)),
      }] : []),
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Filter by this column',
        onClick: () => {
          const col = entityColumns.find((c) => c.key === colKey);
          setAdvancedFilters([
            ...advancedFilters,
            { id: crypto.randomUUID(), field: colKey, operator: col?.type === 'number' ? 'gt' : 'contains', value: '' },
          ]);
        },
      },
    ];

    // ─── ⊢ Definitions ───
    if (!isSystemCol) {
      const resolvedColType: string = fs?.typeDef?.value?.type ?? currentCol?.type ?? 'text';
      const watchedFields: string[] = Array.isArray(fs?.typeDef?.value?.watchedFields) ? fs.typeDef.value.watchedFields : [];
      const typeLabel = fs?.typeDef
        ? `${resolvedColType}${fs.typeDef.value?.format ? ` (${fs.typeDef.value.format})` : ''}${resolvedColType === 'lastModifiedTime' && watchedFields.length > 0 ? ` — watching ${watchedFields.length} field${watchedFields.length !== 1 ? 's' : ''}` : ''}`
        : `${currentCol?.type ?? 'text'} (inferred)`;

      items.push(
        { label: '', onClick: () => {}, separator: true },
        { header: true, icon: '⊢', label: 'Definitions', onClick: () => {} },
        {
          label: `Type: ${typeLabel}`,
          onClick: () => {
            setColumnTypeSelector({ key: colKey, x: columnMenu?.x ?? 0, y: columnMenu?.y ?? 0 });
            setColumnMenu(null);
          },
        },
        // For lastModifiedTime columns: offer watched-fields configuration
        ...(resolvedColType === 'lastModifiedTime' ? [{
          label: watchedFields.length > 0 ? 'Configure watched fields…' : 'Configure watched fields…',
          icon: '⊛',
          onClick: () => {
            setWatchedFieldsPicker({ key: colKey, x: columnMenu?.x ?? 0, y: columnMenu?.y ?? 0 });
            setColumnMenu(null);
          },
        }] : []),
        // List existing constraints (click to remove)
        ...fs?.constraints.map(c => ({
          label: `Constraint: ${c.name}`,
          onClick: () => handleRemoveConstraint(colKey, c.name),
        })) ?? [],
        {
          label: 'Add constraint...',
          onClick: () => {
            setConstraintComposer({ key: colKey, x: columnMenu?.x ?? 0, y: columnMenu?.y ?? 0 });
            setColumnMenu(null);
          },
        },
      );

      // ─── ⊨ Evaluations ───
      // normalizeResolvePolicy absorbs both legacy shapes (lowercase stances
      // and pre-composer {strategy}) at the read boundary, so the column
      // menu only ever sees the canonical titlecase form downstream.
      const currentPolicy: ResolvePolicy | null = normalizeResolvePolicy(fs?.resolve?.value);
      items.push(
        { label: '', onClick: () => {}, separator: true },
        { header: true, icon: '⊨', label: 'Evaluations', onClick: () => {} },
        {
          label: currentPolicy
            ? `Resolution: ${summarizePolicy(currentPolicy)}`
            : 'Set resolution...',
          onClick: () => {
            setResolutionComposer({ key: colKey, x: columnMenu?.x ?? 0, y: columnMenu?.y ?? 0 });
            setColumnMenu(null);
          },
        },
      );
    }

    // ─── Visibility ───
    items.push({ label: '', onClick: () => {}, separator: true });
    if (!isSystemCol) {
      items.push(
        {
          label: displayField === colKey ? 'Display name (active)' : 'Use as display name',
          onClick: async () => {
            const newField = displayField === colKey ? null : colKey;
            try {
              await dispatch({
                op: 'DEF',
                target: scope,
                operand: { _displayField: newField },
                agent: `user:${session.userId}`,
                ts: new Date().toISOString(),
                acquired_ts: new Date().toISOString(),
              });
              setAuditableDisplayField(newField);
            } catch { /* ignore */ }
          },
        },
        { label: '', onClick: () => {}, separator: true },
      );
    }
    items.push({
      label: 'Hide column',
      onClick: () => sliceStore.toggleHiddenColumn(scope, colKey),
    });
    if (hiddenColumns.size > 0) {
      items.push({
        label: `Show all columns (${hiddenColumns.size} hidden)`,
        onClick: () => sliceStore.showAllColumns(scope),
      });
    }
    return items;
  }

  async function handleColumnRename(fieldKey: string, newLabel: string) {
    const schemaTarget = `${scope}._schema.${fieldKey}`;
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTarget,
        operand: { _label: newLabel },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      // Update local field name map immediately
      setFieldNameMap((prev) => {
        const next = new Map(prev);
        next.set(fieldKey, newLabel);
        return next;
      });
    } catch { /* ignore */ }
    setRenameCol(null);
  }

  async function handleSetColumnType(fieldKey: string, type: string, linkedTable?: string | string[], keepOpen = false) {
    const operand: Record<string, unknown> = { type };
    if (linkedTable) {
      const arr = Array.isArray(linkedTable) ? linkedTable : [linkedTable];
      const unique = [...new Set(arr.filter(s => typeof s === 'string' && s.length > 0))];
      if (unique.length > 0) {
        // 'link' and 'relationship' store EO scope paths under 'linkedTable' /
        // 'linkedTables'. 'linkedRecord' (legacy Airtable) stores under
        // 'linkedTableId'. Multiple source tables are stored as 'linkedTables'.
        if (type === 'link' || type === 'relationship') {
          operand.linkedTable = unique[0];
          if (unique.length > 1) operand.linkedTables = unique;
        } else {
          operand.linkedTableId = unique[0];
          if (unique.length > 1) operand.linkedTables = unique;
        }
      }
    }
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTypeTarget(scope, fieldKey),
        operand,
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      // Update local state immediately
      setColumnTypeOverrides((prev) => {
        const next = new Map(prev);
        next.set(fieldKey, operand);
        return next;
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        next.set(fieldKey, {
          ...existing,
          typeDef: { target: schemaTypeTarget(scope, fieldKey), value: operand },
        });
        return next;
      });
    } catch { /* ignore */ }
    if (!keepOpen) {
      setColumnTypeSelector(null);
      setLinkedRecordPicker(null);
    }
  }

  async function handleClearColumnType(fieldKey: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTypeTarget(scope, fieldKey),
        operand: {},
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setColumnTypeOverrides((prev) => {
        const next = new Map(prev);
        next.delete(fieldKey);
        return next;
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey);
        if (existing) {
          next.set(fieldKey, { ...existing, typeDef: undefined });
        }
        return next;
      });
    } catch { /* ignore */ }
    setColumnTypeSelector(null);
  }

  async function handleSetResolution(fieldKey: string, policy: ResolvePolicy) {
    try {
      await dispatch({
        op: 'EVA',
        target: schemaResolveTarget(scope, fieldKey),
        operand: policy,
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        next.set(fieldKey, {
          ...existing,
          resolve: { target: schemaResolveTarget(scope, fieldKey), value: policy },
        });
        return next;
      });
    } catch { /* ignore */ }
    setResolutionComposer(null);
  }

  async function handleClearResolution(fieldKey: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaResolveTarget(scope, fieldKey),
        operand: {},
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey);
        if (existing) {
          next.set(fieldKey, { ...existing, resolve: undefined });
        }
        return next;
      });
    } catch { /* ignore */ }
    setResolutionComposer(null);
  }

  async function handleSaveWatchedFields(fieldKey: string, watchedFields: string[]) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaTypeTarget(scope, fieldKey),
        operand: { type: 'lastModifiedTime', watchedFields },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        next.set(fieldKey, {
          ...existing,
          typeDef: { target: schemaTypeTarget(scope, fieldKey), value: { type: 'lastModifiedTime', watchedFields } },
        });
        return next;
      });
    } catch { /* ignore */ }
    setWatchedFieldsPicker(null);
  }

  async function handleAddConstraint(fieldKey: string, name: string, value: any) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaConstraintTarget(scope, fieldKey, name),
        operand: value,
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey) ?? { fieldKey, constraints: [] };
        const constraints = existing.constraints.filter(c => c.name !== name);
        constraints.push({ target: schemaConstraintTarget(scope, fieldKey, name), name, value });
        next.set(fieldKey, { ...existing, constraints });
        return next;
      });
    } catch { /* ignore */ }
  }

  async function handleRemoveConstraint(fieldKey: string, name: string) {
    try {
      await dispatch({
        op: 'DEF',
        target: schemaConstraintTarget(scope, fieldKey, name),
        operand: {},
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
      setFieldSchemas((prev) => {
        const next = new Map(prev);
        const existing = next.get(fieldKey);
        if (existing) {
          next.set(fieldKey, {
            ...existing,
            constraints: existing.constraints.filter(c => c.name !== name),
          });
        }
        return next;
      });
    } catch { /* ignore */ }
  }

  const canEdit = sliceReadOnly ? false : (permissions ? (permissions.can_edit_any_record || permissions.can_edit_own_records) : true);

  function extractLinkIds(value: unknown): string[] {
    if (value == null) return [];
    if (typeof value === 'string') {
      if (value.startsWith('[') && value.endsWith(']')) {
        try {
          const p = JSON.parse(value);
          if (Array.isArray(p)) return p.filter((v): v is string => typeof v === 'string');
        } catch { /* fall through */ }
      }
      return value ? [value] : [];
    }
    if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
    if (typeof value === 'object') {
      const linked = (value as { linked?: unknown }).linked;
      if (Array.isArray(linked)) return linked.filter((v): v is string => typeof v === 'string');
    }
    return [];
  }

  function resolveLinkedTables(fieldKey: string, currentIds: string[]): string[] {
    const override = columnTypeOverrides.get(fieldKey);
    const out = new Set<string>();
    const linkedTables = override?.linkedTables;
    if (Array.isArray(linkedTables)) {
      for (const t of linkedTables) if (typeof t === 'string' && t) out.add(t);
    }
    if (typeof override?.linkedTable === 'string' && override.linkedTable) out.add(override.linkedTable);
    if (typeof override?.linkedTableId === 'string' && override.linkedTableId) out.add(override.linkedTableId);
    // Fall back: infer from existing linked IDs via the resolver.
    if (out.size === 0) {
      for (const id of currentIds) {
        const resolved = idResolver?.resolve(id);
        if (resolved) out.add(resolved.target.split('.').slice(0, -1).join('.'));
      }
    }
    return [...out];
  }

  function handleCellDoubleClick(rec: EoState, colKey: string, colType?: string) {
    if (!canEdit) return;
    if (colKey === '_record' || colKey === '_last_updated') return;
    if (permissions?.locked_fields?.includes(colKey)) return;
    if (permissions?.redacted_fields?.includes(colKey)) return;
    if (permissions?.type_hidden_fields?.includes(colKey)) return;

    const raw = getFieldValue(rec, colKey, useFieldsSub);

    // Link fields get the Airtable-style picker, never a raw JSON text input.
    if (colType === 'link' || colType === 'linkedRecord' || colType === 'relationship') {
      const currentIds = extractLinkIds(raw);
      const linkedTables = resolveLinkedTables(colKey, currentIds);
      if (linkedTables.length === 0) return;
      setEditingLinkCell({ target: rec.target, fieldKey: colKey, linkedTables });
      return;
    }

    const strVal = raw != null && typeof raw === 'object'
      ? JSON.stringify(raw, null, 2)
      : String(raw ?? '');
    setEditingCell({ target: rec.target, fieldKey: colKey, value: strVal });
  }

  async function handleLinkCellSave(target: string, fieldKey: string, ids: string[]) {
    const rec = records.find((r) => r.target === target);
    const prior = rec ? getFieldValue(rec, fieldKey, useFieldsSub) : undefined;
    const isFirstFill =
      prior === undefined ||
      prior === null ||
      prior === '' ||
      (Array.isArray(prior) && prior.length === 0);
    try {
      if (isFirstFill) {
        await dispatch(
          buildMakingDefEvent(target, fieldKey, ids, `user:${session.userId}`, useFieldsSub),
        );
      } else {
        const operand = useFieldsSub
          ? { fields: { [fieldKey]: ids } }
          : { [fieldKey]: ids };
        await dispatch({
          op: 'DEF',
          target,
          operand,
          agent: `user:${session.userId}`,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
        });
      }
      syncEditToAirtable({ target, fieldKey, value: ids, getStateByPrefix }).catch(console.warn);
    } catch { /* ignore */ }
  }

  async function handleCellSave(target: string, fieldKey: string, rawValue: string) {
    // Cancel any pending debounced dispatch before the final save
    if (editDebounceRef.current !== null) {
      clearTimeout(editDebounceRef.current);
      editDebounceRef.current = null;
    }
    let parsed: any = rawValue;
    try { parsed = JSON.parse(rawValue); } catch { /* keep as string */ }

    // Phase A.6/5 — detect first-fill against the field's prior value and
    // stamp DEF × Making on the resulting event. "First-fill" means the
    // field was previously undefined, null, '' (scalar), or [] (array /
    // multi-select). Any other prior value is a plain update and keeps the
    // existing resolution-less DEF shape (reads back as 'unspecified').
    const rec = records.find((r) => r.target === target);
    const prior = rec ? getFieldValue(rec, fieldKey, useFieldsSub) : undefined;
    const isFirstFill =
      prior === undefined ||
      prior === null ||
      prior === '' ||
      (Array.isArray(prior) && prior.length === 0);

    try {
      if (isFirstFill) {
        await dispatch(
          buildMakingDefEvent(
            target,
            fieldKey,
            parsed,
            `user:${session.userId}`,
            useFieldsSub,
          ),
        );
      } else {
        const operand = useFieldsSub
          ? { fields: { [fieldKey]: parsed } }
          : { [fieldKey]: parsed };
        await dispatch({
          op: 'DEF',
          target,
          operand,
          agent: `user:${session.userId}`,
          ts: new Date().toISOString(),
          acquired_ts: new Date().toISOString(),
        });
      }
      syncEditToAirtable({ target, fieldKey, value: parsed, getStateByPrefix }).catch(console.warn);
    } catch { /* ignore */ }
    setEditingCell(null);
  }

  /**
   * Clear a field value via the explicit "Clear value" / "Clear all" context
   * menu — a different semantic from editing to an empty string. We emit the
   * existing DEF with the empty-value sentinel first so the state map and the
   * UI rendering stay in sync with the current behavior, then dispatch a
   * NUL × Clearing observation so the NulHorizon records the deliberate
   * erasure. Phase A.6/3.
   *
   * The NUL is fire-and-forget audit metadata — a failure to record it must
   * not surface to the user (the state mutation already succeeded).
   */
  async function handleCellClear(target: string, fieldKey: string, emptyRawValue: '' | '[]') {
    await handleCellSave(target, fieldKey, emptyRawValue);
    try {
      await dispatch(buildNulClearingEvent(target, fieldKey, `user:${session.userId}`));
    } catch { /* audit metadata — swallow */ }
  }

  /**
   * Dispatch a cell edit without closing the editor.
   * Used for real-time per-character sync — other users see changes as you type.
   */
  async function dispatchCellEdit(target: string, fieldKey: string, rawValue: string) {
    let parsed: any = rawValue;
    try { parsed = JSON.parse(rawValue); } catch { /* keep as string */ }

    const operand = useFieldsSub
      ? { fields: { [fieldKey]: parsed } }
      : { [fieldKey]: parsed };

    try {
      await dispatch({
        op: 'DEF',
        target,
        operand,
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    // Do NOT call setEditingCell(null) — keep editing
  }

  function handleContextMenu(e: React.MouseEvent, target: string) {
    e.preventDefault();
    e.stopPropagation();
    const rec = records.find((r) => r.target === target);
    void rec;
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  }

  /** Right-click on a cell — shows a type-aware context menu for select/relation fields. */
  function handleCellContextMenu(e: React.MouseEvent, rec: EoState, col: ColumnDef) {
    const interceptTypes = new Set(['select', 'multiSelect', 'link', 'linkedRecord', 'relationship']);
    if (!interceptTypes.has(col.type)) return; // fall through to row handler
    e.preventDefault();
    e.stopPropagation();
    setCellContextMenu({ x: e.clientX, y: e.clientY, target: rec.target, fieldKey: col.key });
  }

  function getCellContextMenuItems(target: string, col: ColumnDef): ContextMenuItem[] {
    const rec = records.find((r) => r.target === target);
    const rawValue = rec ? getFieldValue(rec, col.key, useFieldsSub) : undefined;
    const items: ContextMenuItem[] = [];

    if (col.type === 'select') {
      const currentVal: string = typeof rawValue === 'string'
        ? rawValue
        : (rawValue?.name ? String(rawValue.name) : '');
      const opts = col.selectOptions ?? [];
      items.push({ header: true, label: 'Set value', onClick: () => {}, icon: '○' });
      if (opts.length === 0) {
        items.push({ label: 'No options defined', onClick: () => {}, disabled: true });
      } else {
        for (const opt of opts) {
          items.push({
            label: opt,
            icon: currentVal === opt ? '✓' : '',
            onClick: () => handleCellSave(target, col.key, opt),
          });
        }
      }
      if (currentVal) {
        items.push({ label: '', onClick: () => {}, separator: true });
        items.push({
          label: 'Clear value',
          danger: true,
          // A.6/3: routes through handleCellClear so the deliberate erasure
          // is recorded in the NulHorizon alongside the DEF that empties the
          // state map. Editing a field to an empty string is still a plain
          // handleCellSave — only the explicit "Clear value" menu counts as
          // a Clearing stance.
          onClick: () => handleCellClear(target, col.key, ''),
        });
      }
    } else if (col.type === 'multiSelect') {
      let currentArr: string[] = [];
      if (Array.isArray(rawValue)) {
        currentArr = rawValue.map((v: any) => (typeof v === 'object' && v?.name ? String(v.name) : String(v)));
      }
      const currentSet = new Set(currentArr);
      const opts = col.selectOptions ?? [];
      items.push({ header: true, label: 'Toggle options', onClick: () => {}, icon: '○' });
      if (opts.length === 0) {
        items.push({ label: 'No options defined', onClick: () => {}, disabled: true });
      } else {
        for (const opt of opts) {
          const isActive = currentSet.has(opt);
          items.push({
            label: opt,
            icon: isActive ? '✓' : '',
            onClick: () => {
              const next = isActive
                ? currentArr.filter((v) => v !== opt)
                : [...currentArr, opt];
              handleCellSave(target, col.key, JSON.stringify(next));
            },
          });
        }
      }
      if (currentArr.length > 0) {
        items.push({ label: '', onClick: () => {}, separator: true });
        items.push({
          label: 'Clear all',
          danger: true,
          // A.6/3: same NUL × Clearing audit path as the single-value menu,
          // just with the empty-array sentinel instead of empty string.
          onClick: () => handleCellClear(target, col.key, '[]'),
        });
      }
    } else if (col.type === 'link' || col.type === 'linkedRecord' || col.type === 'relationship') {
      // Linked record chips — show current links and option to edit
      const linked: string[] = [];
      if (typeof rawValue === 'object' && rawValue !== null && Array.isArray(rawValue?.linked)) {
        linked.push(...rawValue.linked);
      } else if (Array.isArray(rawValue)) {
        linked.push(...rawValue.filter((v: any) => typeof v === 'string'));
      } else if (typeof rawValue === 'string' && rawValue) {
        linked.push(rawValue);
      }

      if (linked.length > 0) {
        items.push({ header: true, label: 'Linked records', onClick: () => {}, icon: '⊢' });
        for (const id of linked.slice(0, 8)) {
          const shortId = id.split('.').pop() || id;
          const resolved = idResolver?.resolveTarget(id) ?? idResolver?.resolve(shortId);
          const label = resolved?.name ? `${shortId} · ${resolved.name}` : shortId;
          items.push({
            label,
            onClick: () => onSelectRecord(id),
          });
        }
        if (linked.length > 8) {
          items.push({ label: `…and ${linked.length - 8} more`, onClick: () => {}, disabled: true });
        }
        items.push({ label: '', onClick: () => {}, separator: true });
      }

      items.push({
        label: 'Edit links…',
        icon: '✎',
        onClick: () => {
          setCellContextMenu(null);
          handleCellDoubleClick(rec!, col.key);
        },
        disabled: !rec || !canEdit,
      });
    }

    // Universal fallback — raw text edit
    items.push({ label: '', onClick: () => {}, separator: true });
    items.push({
      label: 'Edit raw value',
      onClick: () => {
        setCellContextMenu(null);
        if (rec) handleCellDoubleClick(rec, col.key);
      },
      disabled: !rec || !canEdit,
    });
    return items;
  }

  function getContextMenuItems(target: string): ContextMenuItem[] {
    const rec = records.find((r) => r.target === target);
    const canEdit = permissions ? permissions.can_edit_any_record || permissions.can_edit_own_records : true;
    const items: ContextMenuItem[] = [];

    if (canEdit) {
      items.push({
        label: rec?.value?._type ? `Change type (${rec.value._type})` : 'Set page type...',
        onClick: () => {
          setTypeSelector({
            x: contextMenu!.x,
            y: contextMenu!.y,
            target,
            currentType: rec?.value?._type,
          });
          setContextMenu(null);
        },
      });
    }

    items.push({
      label: 'View history',
      onClick: () => {
        onViewHistory?.(target);
        onSelectRecord(target);
      },
    });
    items.push({ label: '', onClick: () => {}, separator: true });
    items.push({
      label: 'Copy target path',
      onClick: () => navigator.clipboard.writeText(target),
    });

    return items;
  }

  async function handleAddRecord() {
    const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const recordTarget = `${scope}.rec${shortId}`;
    try {
      await dispatch({
        op: 'INS',
        target: recordTarget,
        operand: {},
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
        client_event_id: crypto.randomUUID(),
      });
      onSelectRecord(recordTarget);
    } catch { /* ignore */ }
  }

  // ── Per-table "Sync from Airtable" ──
  //
  // Runs a full hydration scoped to *just this table*. We intentionally use
  // hydrationSync (not smartSync) so the button also catches records that
  // were never previously synced — e.g. rows added in Airtable since the
  // initial import, or rows that fell outside an earlier selective / limited
  // pull. Incremental LAST_MODIFIED_TIME() syncs only see rows that changed
  // since the cursor was last advanced, so they miss "missing but unchanged"
  // records.
  //
  // hydrationSync emits stable client_event_ids per record, so re-running it
  // is idempotent for unchanged rows. Updated fields still flow through DEF
  // (and NUL where a field cleared) with source='airtable', giving us full
  // per-field provenance in the event log — the standard EO change tracking.
  //
  // Gated through `runAirtableSync` so a manual click can't interleave with
  // the continuous tick or another in-flight sync on the same tab.
  async function handleSyncFromAirtable() {
    if (!airtableSource) return;
    const eoStore = useEoStore.getState().store;
    if (!eoStore || !airtableApiKey) {
      setTableSyncState({ phase: 'error', message: 'Airtable is not connected — open Settings to connect.' });
      return;
    }
    const { baseId, tableId } = airtableSource;
    setTableSyncState({ phase: 'syncing', message: 'Starting…' });
    try {
      const client = createAirtableClient();
      const { syncSettings } = useAirtableStore.getState();
      const customization: SyncCustomization = {
        selectedTables: { [baseId]: [tableId] },
        preserveExisting: syncSettings.preserveExisting,
        recordLimit: syncSettings.recordLimit > 0 ? syncSettings.recordLimit : undefined,
      };
      const progressListener = createImportProgressListener();
      let result;
      try {
        result = await runAirtableSync(
          'manual-table-sync',
          () => hydrationSync(eoStore, client, session.userId, {
            customization,
            onEvent: progressListener.onEvent,
            onProgress: (p) => {
              const tbl = p.table ?? scopeName ?? 'table';
              const so = p.records_so_far ? ` (${p.records_so_far})` : '';
              setTableSyncState({ phase: 'syncing', message: `Syncing ${tbl}${so}…` });
            },
          }),
        );
      } finally {
        progressListener.finalize();
      }
      if (result.total_records_ingested > 0) {
        try {
          await useEoStore.getState().flushToOpfs();
        } catch (e) {
          console.warn('[EO-DB] post-sync flushToOpfs failed:', e);
        }
      }
      const { total_records_ingested, total_records_overwritten, total_records_skipped, duration_ms } = result;
      const dur = `${(duration_ms / 1000).toFixed(1)}s`;
      const msg = total_records_overwritten > 0
        ? `${total_records_ingested} synced, ${total_records_overwritten} updated, ${total_records_skipped} unchanged (${dur})`
        : `${total_records_ingested} synced, ${total_records_skipped} unchanged (${dur})`;
      setTableSyncState({ phase: 'done', message: msg });
      useAirtableStore.getState().setLastSyncAt(new Date().toISOString());
    } catch (e: any) {
      const busy = e instanceof SyncBusyError;
      setTableSyncState({
        phase: 'error',
        message: busy
          ? `Another sync is running (${e.active}) — wait, then try again`
          : (e?.message || 'Sync failed'),
      });
    }
  }

  async function handleSaveSegment(name: string) {
    try {
      await dispatch({
        op: 'SEG',
        target: `${scope}._segments.${name.replace(/\s+/g, '_').toLowerCase()}`,
        operand: {
          name,
          filters: advancedFilters,
          conjunction: filterConjunction,
          created_at: new Date().toISOString(),
        },
        agent: `user:${session.userId}`,
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  }

  async function handleTypeChange(target: string, type: string) {
    try {
      await dispatch({
        op: 'DEF',
        target,
        operand: { _type: type || undefined },
        agent: 'user',
        ts: new Date().toISOString(),
        acquired_ts: new Date().toISOString(),
      });
    } catch { /* ignore */ }
    setTypeSelector(null);
  }

  // ─── Field value stats for the side-panel headline ───────────────────
  // Computed from the loaded records whenever the user opens the panel on
  // a column. Gives the editor a headline view of what's actually in the
  // column before they start changing its settings.
  //
  // IMPORTANT: this runs in an effect (not a useMemo) so that the scan
  // happens AFTER React commits the state change that opens the panel.
  // Otherwise, double-clicking a column header on a large scope (5000+
  // records) freezes the UI — the synchronous scan blocks the commit so
  // the side panel can't paint until the whole loop finishes.
  const [fieldValueStats, setFieldValueStats] = useState<FieldValueStats | null>(null);
  useEffect(() => {
    if (!fieldPanelKey) {
      setFieldValueStats(null);
      return;
    }
    let cancelled = false;

    const w = window as typeof window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const schedule = (cb: () => void): { kind: 'idle'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> } =>
      typeof w.requestIdleCallback === 'function'
        ? { kind: 'idle', id: w.requestIdleCallback(cb, { timeout: 200 }) }
        : { kind: 'timeout', id: setTimeout(cb, 0) };
    const cancelScheduled = (h: { kind: 'idle'; id: number } | { kind: 'timeout'; id: ReturnType<typeof setTimeout> }) => {
      if (h.kind === 'idle' && typeof w.cancelIdleCallback === 'function') {
        w.cancelIdleCallback(h.id);
      } else if (h.kind === 'timeout') {
        clearTimeout(h.id);
      }
    };

    const handle = schedule(() => {
      if (cancelled) return;
      let filled = 0;
      const distinctSet = new Set<string>();
      let numMin = Infinity;
      let numMax = -Infinity;
      let numCount = 0;
      const counts = new Map<string, number>();
      let lenSum = 0;
      let lenCount = 0;
      const total = records.length;
      for (const rec of records) {
        const v = getFieldValue(rec, fieldPanelKey, useFieldsSub);
        if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
        filled++;
        let key: string;
        if (typeof v === 'object') {
          try { key = JSON.stringify(v); } catch { key = String(v); }
        } else {
          key = String(v);
        }
        distinctSet.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (typeof v === 'number' && Number.isFinite(v)) {
          numCount++;
          if (v < numMin) numMin = v;
          if (v > numMax) numMax = v;
        }
        if (typeof v === 'string') {
          lenSum += v.length;
          lenCount++;
        }
      }
      const topValues = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([value, count]) => ({
          value: value.length > 40 ? value.slice(0, 40) + '…' : value,
          count,
        }));
      if (cancelled) return;
      setFieldValueStats({
        total,
        filled,
        distinct: distinctSet.size,
        numeric: numCount > 0 ? { min: numMin, max: numMax } : undefined,
        textAvgLen: lenCount > 0 ? Math.round(lenSum / lenCount) : undefined,
        topValues: topValues.length > 0 ? topValues : undefined,
      });
    });

    return () => {
      cancelled = true;
      cancelScheduled(handle);
    };
  }, [fieldPanelKey, records, useFieldsSub]);

  return (
    <div style={s.container}>
      {/* Toolbar */}
      <div style={{
        ...s.toolbar,
        ...(isMobile ? { padding: '8px 12px' } : {}),
      }}>
        <div style={s.toolbarLeft}>
          <div style={s.scopeName}>{scopeName || formatScopeName(scope)}</div>
          <span style={s.recordCount}>{filtered.length}</span>
          {selectedRows.size > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '2px 8px', borderRadius: 10,
              background: theme.accentBg, color: theme.accent,
              border: `1px solid ${theme.accentBorder}`,
              fontSize: 11, fontWeight: 600,
            }}>
              {selectedRows.size} selected
              <button
                onClick={deselectAllRows}
                title="Clear selection"
                aria-label="Clear selection"
                style={{
                  background: 'none', border: 'none', color: theme.accent,
                  cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1,
                }}
              >
                {'\u2715'}
              </button>
            </span>
          )}
          <TableUpdateIndicator
            isUpdating={isUpdating}
            lastUpdate={lastUpdate}
            records={records}
            scope={scope}
            onOpenDetail={() => setShowUpdateDetail(true)}
            theme={theme}
          />
          {!isMobile && (() => {
            const totalDefs = Array.from(fieldSchemas.values()).reduce(
              (sum, fs) => sum + (fs.typeDef ? 1 : 0) + fs.constraints.length, 0);
            const totalEvas = Array.from(fieldSchemas.values()).reduce(
              (sum, fs) => sum + (fs.resolve ? 1 : 0), 0);
            if (totalDefs === 0 && totalEvas === 0) return null;
            return (
              <span style={s.schemaBadges}>
                {totalDefs > 0 && <span style={s.schemaBadge}>{totalDefs} DEF</span>}
                {totalEvas > 0 && <span style={s.schemaBadge}>{totalEvas} EVA</span>}
              </span>
            );
          })()}
          {(permissions?.can_add_records !== false) && (
            <button onClick={handleAddRecord} style={{
              ...s.addRecordBtn,
              ...(isMobile ? { padding: '0 10px', fontSize: 11 } : {}),
            }}>
              + New
            </button>
          )}
          {airtableSource && (
            <AirtableSyncTableButton
              connected={airtableConnected && !!airtableApiKey}
              isSyncing={airtableIsSyncing || tableSyncState.phase === 'syncing'}
              syncState={tableSyncState}
              onSync={handleSyncFromAirtable}
              isMobile={isMobile}
              theme={theme}
            />
          )}
        </div>
        <div style={s.toolbarRight}>
          <FilterBar
            columns={entityColumns}
            filters={advancedFilters}
            onFiltersChange={setAdvancedFilters}
            conjunction={filterConjunction}
            onConjunctionChange={setFilterConjunction}
            onSaveSegment={handleSaveSegment}
            scope={scope}
          />
          <SortPanel
            columns={columns}
            sorts={sorts}
            onSortsChange={setSorts}
          />
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search…"
            style={{
              ...s.filterInput,
              ...(isMobile
                ? { width: 'auto', flex: '1 1 100px', minWidth: 80 }
                : { width: 'auto', flex: '0 1 180px', minWidth: 120 }),
            }}
          />

          {/* Select all / deselect all toggle */}
          <button
            onClick={allVisibleSelected ? deselectAllRows : selectAllVisible}
            disabled={filtered.length === 0}
            title={allVisibleSelected ? 'Deselect all visible rows' : 'Select all visible rows'}
            aria-label={allVisibleSelected ? 'Deselect all visible rows' : 'Select all visible rows'}
            aria-pressed={allVisibleSelected}
            style={{
              ...s.toggleBtn,
              padding: '0 8px',
              minWidth: 28,
              fontWeight: allVisibleSelected || someVisibleSelected ? 600 : 400,
              background: allVisibleSelected || someVisibleSelected ? theme.accentBg : 'transparent',
              color: allVisibleSelected || someVisibleSelected ? theme.accent : theme.textMuted,
              border: `1px solid ${allVisibleSelected || someVisibleSelected ? theme.accentBorder : theme.border}`,
              borderRadius: 4,
              cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
              opacity: filtered.length === 0 ? 0.5 : 1,
            }}
          >
            {allVisibleSelected ? 'Deselect all' : someVisibleSelected ? `Select all (${visibleSelectedCount}/${filtered.length})` : 'Select all'}
          </button>

          {/* Row height toggle — hidden on mobile */}
          {!isMobile && (
          <div style={{ display: 'flex', gap: 2 }}>
            {(['compact', 'default', 'tall'] as const).map((h, i) => {
              const labels = ['S', 'M', 'L'];
              const isActive = rowHeight === h;
              return (
                <button
                  key={h}
                  onClick={() => sliceStore.setRowHeight(scope, h)}
                  title={h.charAt(0).toUpperCase() + h.slice(1)}
                  style={{
                    ...s.toggleBtn,
                    padding: '0 6px',
                    minWidth: 24,
                    background: isActive ? theme.accentBg : 'transparent',
                    color: isActive ? theme.accent : theme.textMuted,
                    border: `1px solid ${isActive ? theme.accentBorder : theme.border}`,
                    borderRadius: i === 0 ? '4px 0 0 4px' : i === 2 ? '0 4px 4px 0' : 0,
                    borderRight: i < 2 ? 'none' : undefined,
                  }}
                >
                  {labels[i]}
                </button>
              );
            })}
          </div>
          )}

          {/* Cell overflow toggle — hidden on mobile */}
          {!isMobile && (
          <div style={{ display: 'flex', gap: 2 }}>
            {(['clip', 'wrap'] as const).map((mode, i) => {
              const isActive = cellOverflow === mode;
              const icon = mode === 'clip' ? '\u2014' : '\u21B5';
              const label = mode === 'clip'
                ? 'Truncate cell text with ellipsis'
                : 'Wrap cell text across multiple lines';
              return (
                <button
                  key={mode}
                  onClick={() => sliceStore.setCellOverflow(scope, mode)}
                  title={label}
                  aria-label={label}
                  aria-pressed={isActive}
                  style={{
                    ...s.toggleBtn,
                    padding: '0 8px',
                    minWidth: 28,
                    fontWeight: isActive ? 600 : 400,
                    background: isActive ? theme.accentBg : 'transparent',
                    color: isActive ? theme.accent : theme.textMuted,
                    border: `1px solid ${isActive ? theme.accentBorder : theme.border}`,
                    borderRadius: i === 0 ? '4px 0 0 4px' : '0 4px 4px 0',
                    borderRight: i === 0 ? 'none' : undefined,
                  }}
                >
                  {icon}
                </button>
              );
            })}
          </div>
          )}

          {/* Column manager (Fields) */}
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setShowColumnManager((prev) => !prev)}
              style={{
                ...s.toggleBtn,
                background: hiddenColumns.size > 0 ? theme.accentBg : 'transparent',
                color: hiddenColumns.size > 0 ? theme.accent : theme.textMuted,
                border: `1px solid ${hiddenColumns.size > 0 ? theme.accentBorder : theme.border}`,
              }}
              title="Show/hide and reorder table columns"
            >
              {'\u2630'}{!isMobile && <> Fields{hiddenColumns.size > 0 ? ` (${hiddenColumns.size} hidden)` : ''}</>}
            </button>
            {showColumnManager && (
              <ColumnManagerPanel
                allColumns={[
                  { key: '_record', label: 'record', type: 'text' as const },
                  ...entityColumns,
                  { key: '_last_updated', label: 'last updated', type: 'text' as const },
                ]}
                columnOrder={columnOrder}
                hiddenColumns={hiddenColumns}
                onToggleColumn={(key) => sliceStore.toggleHiddenColumn(scope, key)}
                onReorder={(order) => sliceStore.setColumnOrder(scope, order)}
                onShowAll={() => sliceStore.showAllColumns(scope)}
                onHideAll={() => {
                  const allKeys = entityColumns.map((c) => c.key).concat(['_record', '_last_updated']);
                  sliceStore.setHiddenColumns(scope, allKeys);
                }}
                onClose={() => setShowColumnManager(false)}
                onAddColumn={() => { setShowColumnManager(false); setShowAddColumn(true); }}
              />
            )}
          </div>

          {/* Profile fields picker */}
          <div style={{ position: 'relative' as const }}>
            <button
              onClick={() => setShowProfilePicker((prev) => !prev)}
              style={{
                ...s.toggleBtn,
                background: profileFields ? theme.accentBg : 'transparent',
                color: profileFields ? theme.accent : theme.textMuted,
                border: `1px solid ${profileFields ? theme.accentBorder : theme.border}`,
              }}
              title="Choose which fields appear in the record detail drawer"
            >
              {'\u229E'} Detail fields
            </button>
            {showProfilePicker && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
                  onClick={() => setShowProfilePicker(false)}
                />
                <div style={{
                  position: 'absolute', top: '100%', right: 0, zIndex: 9999,
                  background: theme.bgCard, border: `1px solid ${theme.border}`,
                  borderRadius: 8, padding: 12, boxShadow: `0 8px 30px ${theme.shadow}`,
                  minWidth: 200, maxHeight: 320, overflowY: 'auto',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 8, color: theme.textHeading }}>
                    Detail Fields
                  </div>
                  {entityColumns.map((col) => {
                    const isChecked = !profileFields || profileFields.includes(col.key);
                    return (
                      <label
                        key={col.key}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '4px 0', fontSize: 12, color: theme.text, cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {
                            const current = profileFields || entityColumns.map((c) => c.key);
                            const next = isChecked
                              ? current.filter((k) => k !== col.key)
                              : [...current, col.key];
                            sliceStore.setProfileFields(scope, next.length === entityColumns.length ? undefined : next);
                          }}
                        />
                        {col.label}
                      </label>
                    );
                  })}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, borderTop: `1px solid ${theme.border}`, paddingTop: 8 }}>
                    <button
                      onClick={() => sliceStore.setProfileFields(scope, undefined)}
                      style={{ fontSize: 10, background: 'none', border: 'none', color: theme.accent, cursor: 'pointer' }}
                    >
                      Select All
                    </button>
                    <button
                      onClick={() => sliceStore.setProfileFields(scope, [])}
                      style={{ fontSize: 10, background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer' }}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div
        ref={tableWrapRef}
        style={s.tableWrap}
        onScroll={(e) => {
          const top = (e.currentTarget as HTMLDivElement).scrollTop;
          if (scrollRafRef.current !== null) return; // already scheduled
          scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            setScrollTop(top);
          });
        }}
      >
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleColumnDragStart} onDragEnd={handleColumnDragEnd} onDragCancel={() => setActiveDragId(null)}>
          <table ref={tableRef} style={{ ...s.table, tableLayout: 'fixed', contain: 'layout style' as React.CSSProperties['contain'] }}>
            <colgroup>
              <col style={{ width: 56 }} />
              {orderedColumns.map((col) => (
                <col key={col.key} style={{ width: columnWidths[col.key] || defaultColumnWidth(col.type) }} />
              ))}
            </colgroup>
            <thead>
              <SortableContext items={orderedColumns.map((c) => c.key)} strategy={horizontalListSortingStrategy}>
                <tr>
                  <th
                    style={{ ...s.th, width: 56, textAlign: 'center', padding: '0 4px', userSelect: 'none', color: theme.textMuted, fontSize: 11 }}
                    title={allVisibleSelected ? 'Deselect all visible rows' : 'Select all visible rows'}
                  >
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={(el) => { if (el) el.indeterminate = someVisibleSelected; }}
                      onChange={() => {
                        if (allVisibleSelected) deselectAllRows();
                        else selectAllVisible();
                      }}
                      disabled={filtered.length === 0}
                      aria-label={allVisibleSelected ? 'Deselect all visible rows' : 'Select all visible rows'}
                      style={{ cursor: filtered.length === 0 ? 'not-allowed' : 'pointer', margin: 0 }}
                    />
                  </th>
                  {orderedColumns.map((col) => (
                    <SortableColumnHeader
                      key={col.key}
                      col={col}
                      theme={theme}
                      thStyle={s.th}
                      sorts={sorts}
                      renameCol={renameCol}
                      permissions={permissions}
                      isResizing={resizing?.key === col.key}
                      isAnyResizing={resizing !== null}
                      disabled={col.key === '_record'}
                      onContextMenu={(e) => handleColumnContextMenu(e, col)}
                      onRename={(val) => handleColumnRename(col.key, val)}
                      onCancelRename={() => setRenameCol(null)}
                      onResizeStart={(startX) => {
                        const width = columnWidths[col.key] || defaultColumnWidth(col.type);
                        setResizing({ key: col.key, startX, startWidth: width });
                      }}
                      onDoubleClick={(e) => {
                        // Double-click on a column header opens the full
                        // field editor side panel. Skip metadata columns —
                        // they aren't user-defined schema fields.
                        if (col.key === '_record' || col.key === '_last_updated') return;
                        e.preventDefault();
                        e.stopPropagation();
                        setFieldPanelKey(col.key);
                      }}
                    />
                  ))}
                  <th
                    style={{
                      ...s.th,
                      width: 40,
                      textAlign: 'center',
                      padding: '0',
                      cursor: 'pointer',
                      color: theme.textMuted,
                      fontSize: 18,
                      fontWeight: 400,
                      borderRight: 'none',
                    }}
                    onClick={() => setShowAddColumn(true)}
                    title="Add field"
                  >+</th>
                </tr>
              </SortableContext>
            </thead>
            <tbody>
              {filtered.length === 0 && recordsLoaded && (
                <tr>
                  <td colSpan={orderedColumns.length + 1} style={s.emptyRow}>
                    {records.length === 0
                      ? (emptyStateSettled ? 'No records in this scope' : 'Loading records…')
                      : 'No records match the current filter'}
                  </td>
                </tr>
              )}
              {useVirtual && spacerTop > 0 && (
                <tr aria-hidden="true"><td colSpan={orderedColumns.length + 1} style={{ height: spacerTop, padding: 0, border: 'none' }} /></tr>
              )}
              {virtualRows.map((rec, rowIndex) => {
                const isActive = rec.target === activeRecord;
                const isSelected = selectedRows.has(rec.target);
                const rowBg = isSelected
                  ? theme.accentBg
                  : isActive ? theme.accentBg : theme.bgCard;
                return (
                  <tr
                    key={rec.target}
                    style={{ background: rowBg }}
                    onClick={() => onSelectRecord(rec.target)}
                    onContextMenu={(e) => handleContextMenu(e, rec.target)}
                    onMouseEnter={(e) => {
                      if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.background = theme.bgHover;
                    }}
                    onMouseLeave={(e) => {
                      if (!isActive && !isSelected) (e.currentTarget as HTMLElement).style.background = theme.bgCard;
                      else if (isSelected && !isActive) (e.currentTarget as HTMLElement).style.background = theme.accentBg;
                    }}
                  >
                    <td style={{
                      ...s.td,
                      width: 56,
                      textAlign: 'center',
                      padding: `${rowHeight === 'compact' ? 4 : rowHeight === 'tall' ? 18 : 10}px 4px`,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      color: theme.textMuted,
                      userSelect: 'none',
                      background: 'inherit',
                    }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => toggleRowSelection(rec.target)}
                          aria-label={isSelected ? `Deselect row ${virtualStart + rowIndex + 1}` : `Select row ${virtualStart + rowIndex + 1}`}
                          style={{ cursor: 'pointer', margin: 0 }}
                        />
                        <span>{virtualStart + rowIndex + 1}</span>
                      </span>
                    </td>
                    {orderedColumns.map((col, colIndex) => {
                      const isRedacted = permissions?.redacted_fields?.includes(col.key);
                      const isLocked = permissions?.locked_fields?.includes(col.key);
                      const tdStyle = s.td;
                      const isEditingThis = editingCell?.target === rec.target && editingCell?.fieldKey === col.key;
                      const isEditableCol = col.key !== '_record' && col.key !== '_last_updated' && !isRedacted && !isLocked && canEdit;
                      return (
                        <td
                          key={col.key}
                          style={{
                            ...tdStyle,
                            padding: `${rowHeight === 'compact' ? 4 : rowHeight === 'tall' ? 18 : 10}px 10px`,
                            ...(cellOverflow === 'clip'
                              ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', wordBreak: 'normal' as const }
                              : { whiteSpace: 'normal', wordBreak: 'break-word' as const }),
                          }}
                          title={col.key === '_record' ? 'Click to open record' : undefined}
                          onDoubleClick={col.key === '_record' ? (e) => {
                            e.stopPropagation();
                            onSelectRecord(rec.target);
                          } : undefined}
                          onContextMenu={isEditableCol ? (e) => handleCellContextMenu(e, rec, col) : undefined}
                          onMouseEnter={col.key === '_record' ? (e) => {
                            const icon = (e.currentTarget as HTMLElement).querySelector('[data-open-icon]') as HTMLElement | null;
                            if (icon) icon.style.opacity = '1';
                          } : undefined}
                          onMouseLeave={col.key === '_record' ? (e) => {
                            const icon = (e.currentTarget as HTMLElement).querySelector('[data-open-icon]') as HTMLElement | null;
                            if (icon) icon.style.opacity = '0';
                          } : undefined}
                        >
                          {isEditingThis && col.type === 'select' && (col.selectOptions?.length ?? 0) > 0
                            ? <select
                                autoFocus
                                value={editingCell.value}
                                style={{
                                  width: '100%',
                                  padding: '2px 4px',
                                  fontSize: 12,
                                  border: `1px solid ${theme.accent}`,
                                  borderRadius: 3,
                                  background: theme.bg,
                                  color: theme.text,
                                  outline: 'none',
                                  boxSizing: 'border-box' as const,
                                  fontFamily: 'inherit',
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  handleCellSave(rec.target, col.key, e.target.value);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    if (editDebounceRef.current !== null) { clearTimeout(editDebounceRef.current); editDebounceRef.current = null; }
                                    setEditingCell(null);
                                  }
                                }}
                                onBlur={(e) => handleCellSave(rec.target, col.key, e.target.value)}
                              >
                                <option value="">—</option>
                                {(col.selectOptions ?? []).map(opt => (
                                  <option key={opt} value={opt}>{opt}</option>
                                ))}
                              </select>
                          : isEditingThis
                            ? <input
                                autoFocus
                                value={editingCell.value}
                                style={{
                                  width: '100%',
                                  padding: '2px 4px',
                                  fontSize: 12,
                                  border: `1px solid ${theme.accent}`,
                                  borderRadius: 3,
                                  background: theme.bg,
                                  color: theme.text,
                                  outline: 'none',
                                  boxSizing: 'border-box' as const,
                                  fontFamily: "'JetBrains Mono', monospace",
                                }}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  const newVal = e.target.value;
                                  setEditingCell({ ...editingCell, value: newVal });
                                  // Debounced real-time dispatch (300ms)
                                  if (editDebounceRef.current !== null) clearTimeout(editDebounceRef.current);
                                  editDebounceRef.current = setTimeout(() => {
                                    editDebounceRef.current = null;
                                    dispatchCellEdit(rec.target, col.key, newVal);
                                  }, 300);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    handleCellSave(rec.target, col.key, (e.target as HTMLInputElement).value);
                                  }
                                  if (e.key === 'Escape') {
                                    if (editDebounceRef.current !== null) { clearTimeout(editDebounceRef.current); editDebounceRef.current = null; }
                                    setEditingCell(null);
                                  }
                                }}
                                onBlur={(e) => handleCellSave(rec.target, col.key, e.target.value)}
                                onFocus={(e) => e.target.select()}
                              />
                          : isRedacted
                            ? <RedactedCell />
                            : col.key === '_record'
                            ? <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
                                <span style={{
                                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                                  color: theme.accent, cursor: 'pointer',
                                }}>{(() => {
                                  const dv = displayField ? getFieldValue(rec, displayField, useFieldsSub) : null;
                                  if (dv != null && typeof dv !== 'object') return String(dv);
                                  return recordNameMap.get(rec.target) || formatName(rec.target.split('.').pop() || '');
                                })()}</span>
                                {rec.value?._type && <TypeBadge type={rec.value._type} />}
                                <span
                                  data-open-icon=""
                                  style={{
                                    opacity: 0,
                                    fontSize: 9,
                                    color: theme.accent,
                                    transition: 'opacity 0.12s',
                                    userSelect: 'none' as const,
                                    lineHeight: 1,
                                    marginLeft: 'auto',
                                  }}
                                >↗</span>
                              </span>
                            : col.key === '_last_updated'
                            ? <span style={{
                                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                                color: theme.textSecondary,
                              }}>{rec.last_ts ? formatRelativeTime(rec.last_ts) : <AbsentCell t={theme} />}</span>
                            : isLocked
                            ? <LockedCell>{renderCell(getFieldValue(rec, col.key, useFieldsSub), col.key, onSelectRecord, theme, idResolver, col.type)}</LockedCell>
                            : isEditableCol
                            ? <span
                                style={{
                                  display: 'inline-block',
                                  borderBottom: '1px solid transparent',
                                  paddingBottom: 1,
                                  minWidth: 8,
                                  minHeight: 14,
                                  cursor: 'text',
                                  transition: 'border-bottom-color 0.12s',
                                  boxSizing: 'border-box' as const,
                                  position: 'relative' as const,
                                }}
                                title="Click to view · click again to edit · right-click for options"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const isActiveRecord = rec.target === activeRecord;
                                  const isSameCell = lastClickedCell?.target === rec.target && lastClickedCell?.fieldKey === col.key;
                                  if (isActiveRecord && isSameCell) {
                                    handleCellDoubleClick(rec, col.key, col.type);
                                    setLastClickedCell(null);
                                  } else {
                                    onSelectRecord(rec.target);
                                    setLastClickedCell({ target: rec.target, fieldKey: col.key });
                                  }
                                }}
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  handleCellDoubleClick(rec, col.key, col.type);
                                  setLastClickedCell(null);
                                }}
                                onMouseEnter={(e) => {
                                  (e.currentTarget as HTMLElement).style.borderBottomColor = theme.borderLight;
                                }}
                                onMouseLeave={(e) => {
                                  (e.currentTarget as HTMLElement).style.borderBottomColor = 'transparent';
                                }}
                              >
                                {renderCell(getFieldValue(rec, col.key, useFieldsSub), col.key, onSelectRecord, theme, idResolver, col.type)}
                              </span>
                            : renderCell(getFieldValue(rec, col.key, useFieldsSub), col.key, onSelectRecord, theme, idResolver, col.type)
                          }
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {useVirtual && spacerBottom > 0 && (
                <tr aria-hidden="true"><td colSpan={orderedColumns.length + 1} style={{ height: spacerBottom, padding: 0, border: 'none' }} /></tr>
              )}
            </tbody>
          </table>
          <DragOverlay dropAnimation={null}>
            {activeDragId && (() => {
              const col = orderedColumns.find(c => c.key === activeDragId);
              if (!col) return null;
              return (
                <div style={{
                  padding: '6px 10px',
                  background: theme.bgCard,
                  border: `2px solid ${theme.accent}`,
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  color: theme.text,
                  boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  whiteSpace: 'nowrap',
                  opacity: 0.9,
                }}>
                  {col.label}
                </div>
              );
            })()}
          </DragOverlay>
        </DndContext>
      </div>

      {/* Right-click context menu (rows) */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={getContextMenuItems(contextMenu.target)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Right-click context menu (cells — select/multiSelect/relation fields) */}
      {cellContextMenu && (() => {
        const col = entityColumns.find(c => c.key === cellContextMenu.fieldKey);
        if (!col) return null;
        return (
          <ContextMenu
            x={cellContextMenu.x}
            y={cellContextMenu.y}
            items={getCellContextMenuItems(cellContextMenu.target, col)}
            onClose={() => setCellContextMenu(null)}
          />
        );
      })()}

      {/* Right-click context menu (columns) */}
      {columnMenu && (
        <ContextMenu
          x={columnMenu.x}
          y={columnMenu.y}
          items={getColumnMenuItems(columnMenu.key, columnMenu.label)}
          onClose={() => setColumnMenu(null)}
        />
      )}

      {/* Type selector popover */}
      {editingLinkCell && (() => {
        const rec = records.find(r => r.target === editingLinkCell.target);
        const currentIds = rec ? extractLinkIds(getFieldValue(rec, editingLinkCell.fieldKey, useFieldsSub)) : [];
        return (
          <LinkFieldPicker
            fieldKey={editingLinkCell.fieldKey}
            linkedTables={editingLinkCell.linkedTables}
            currentIds={currentIds}
            onClose={() => setEditingLinkCell(null)}
            onChange={(ids) => handleLinkCellSave(editingLinkCell.target, editingLinkCell.fieldKey, ids)}
          />
        );
      })()}
      {typeSelector && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setTypeSelector(null)}
          />
          <div style={{
            position: 'fixed',
            left: typeSelector.x,
            top: typeSelector.y,
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
          }}>
            <TypeSelector
              currentType={typeSelector.currentType}
              onSelect={(type) => handleTypeChange(typeSelector.target, type)}
              onClose={() => setTypeSelector(null)}
            />
          </div>
        </>
      )}
      {columnTypeSelector && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setColumnTypeSelector(null)}
          />
          <div style={{
            position: 'fixed',
            left: columnTypeSelector.x,
            top: columnTypeSelector.y,
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
          }}>
            <ColumnTypeSelector
              currentType={
                fieldSchemas.get(columnTypeSelector.key)?.typeDef?.value?.type
                ?? entityColumns.find(c => c.key === columnTypeSelector.key)?.type
                ?? 'text'
              }
              isDefined={!!fieldSchemas.get(columnTypeSelector.key)?.typeDef}
              selectOptions={
                (fieldSchemas.get(columnTypeSelector.key)?.constraints.find(c => c.name === 'enum')?.value?.choices as string[] | undefined)
                ?? entityColumns.find(c => c.key === columnTypeSelector.key)?.selectOptions
              }
              onSaveOptions={(options) => handleAddConstraint(columnTypeSelector.key, 'enum', { choices: options })}
              onSelect={async (type) => {
                if (type === 'linkedRecord' || type === 'link' || type === 'relationship') {
                  // Fetch sibling tables and show a picker before committing.
                  // Table-level state entries don't always exist (keyed imports
                  // only create record-level states like "import.cases.CASE-001").
                  // Derive unique table scopes from the first two path segments of
                  // every returned state instead of relying on depth-2 entries.
                  const states = await getStateByPrefix(scopeRoot + '.');
                  const tableScopeSet = new Set<string>();
                  for (const s of states) {
                    const parts = s.target.split('.');
                    if (parts.length >= 2) {
                      tableScopeSet.add(parts[0] + '.' + parts[1]);
                    }
                  }
                  const tables = [...tableScopeSet]
                    .filter(tableScope => {
                      const seg = tableScope.split('.')[1];
                      return !seg.startsWith('_') && tableScope !== scope;
                    })
                    .map(tableScope => ({ scope: tableScope, name: formatScopeName(tableScope) }));
                  setColumnTypeSelector(null);
                  setLinkedRecordPicker({ x: columnTypeSelector.x, y: columnTypeSelector.y, key: columnTypeSelector.key, tables, mode: type as 'linkedRecord' | 'link' | 'relationship', selected: [] });
                } else if (type === 'select' || type === 'multiSelect') {
                  const key = columnTypeSelector.key;
                  const hasEnumConstraint = !!fieldSchemas.get(key)?.constraints.find(c => c.name === 'enum');
                  const existingOptions = entityColumns.find(c => c.key === key)?.selectOptions ?? [];
                  handleSetColumnType(key, type, undefined, true);
                  if (!hasEnumConstraint && existingOptions.length > 0) {
                    await handleAddConstraint(key, 'enum', { choices: existingOptions });
                  }
                } else {
                  handleSetColumnType(columnTypeSelector.key, type);
                }
              }}
              onClear={() => handleClearColumnType(columnTypeSelector.key)}
              onClose={() => setColumnTypeSelector(null)}
            />
          </div>
        </>
      )}
      {linkedRecordPicker && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
            onClick={() => setLinkedRecordPicker(null)}
          />
          <div style={{
            position: 'fixed',
            left: linkedRecordPicker.x,
            top: linkedRecordPicker.y,
            zIndex: 9999,
            background: theme.bgCard,
            border: `1px solid ${theme.border}`,
            borderRadius: 8,
            boxShadow: `0 8px 30px ${theme.shadow}`,
            minWidth: 220,
            maxWidth: 320,
            padding: '8px 0',
          }}>
            <div style={{ padding: '6px 12px 4px', fontSize: 11, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Link to table{linkedRecordPicker.tables.length > 1 ? 's' : ''}
            </div>
            <div style={{ padding: '0 12px 6px', fontSize: 10, color: theme.textMuted }}>
              Select one or more source tables
            </div>
            {linkedRecordPicker.tables.length === 0 ? (
              <div style={{ padding: '6px 12px', fontSize: 13, color: theme.textMuted }}>No other tables found</div>
            ) : (
              <>
                {linkedRecordPicker.tables.map(tbl => {
                  const isSelected = linkedRecordPicker.selected.includes(tbl.scope);
                  return (
                    <div
                      key={tbl.scope}
                      style={{
                        padding: '7px 12px',
                        fontSize: 13,
                        cursor: 'pointer',
                        color: theme.text,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        background: isSelected ? `${theme.purple}14` : 'transparent',
                      }}
                      onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = theme.bgHover ?? theme.bgMuted; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isSelected ? `${theme.purple}14` : 'transparent'; }}
                      onClick={() => setLinkedRecordPicker(prev => {
                        if (!prev) return prev;
                        const next = prev.selected.includes(tbl.scope)
                          ? prev.selected.filter(s => s !== tbl.scope)
                          : [...prev.selected, tbl.scope];
                        return { ...prev, selected: next };
                      })}
                    >
                      <span style={{
                        width: 14,
                        height: 14,
                        borderRadius: 3,
                        border: `1.5px solid ${isSelected ? theme.purple : theme.border}`,
                        background: isSelected ? theme.purple : 'transparent',
                        flexShrink: 0,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#fff',
                        fontSize: 9,
                        lineHeight: 1,
                        fontWeight: 700,
                      }}>{isSelected ? '✓' : ''}</span>
                      <span>{tbl.name}</span>
                    </div>
                  );
                })}
                <div style={{
                  padding: '8px 12px',
                  borderTop: `1px solid ${theme.borderLight}`,
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 6,
                  marginTop: 4,
                }}>
                  <button
                    onClick={() => setLinkedRecordPicker(null)}
                    style={{
                      background: 'transparent',
                      border: `1px solid ${theme.border}`,
                      borderRadius: 6,
                      padding: '4px 10px',
                      fontSize: 12,
                      color: theme.textMuted,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >Cancel</button>
                  <button
                    disabled={linkedRecordPicker.selected.length === 0}
                    onClick={() => handleSetColumnType(linkedRecordPicker.key, linkedRecordPicker.mode, linkedRecordPicker.selected)}
                    style={{
                      background: linkedRecordPicker.selected.length === 0 ? theme.bgMuted : theme.purple,
                      border: `1px solid ${linkedRecordPicker.selected.length === 0 ? theme.border : theme.purple}`,
                      borderRadius: 6,
                      padding: '4px 10px',
                      fontSize: 12,
                      color: linkedRecordPicker.selected.length === 0 ? theme.textMuted : '#fff',
                      cursor: linkedRecordPicker.selected.length === 0 ? 'not-allowed' : 'pointer',
                      fontFamily: 'inherit',
                      fontWeight: 500,
                    }}
                  >Link</button>
                </div>
              </>
            )}
          </div>
        </>
      )}
      {resolutionComposer && (() => {
        const fs = fieldSchemas.get(resolutionComposer.key);
        const currentPolicy: ResolvePolicy | null = normalizeResolvePolicy(fs?.resolve?.value);
        return (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
              onClick={() => setResolutionComposer(null)}
            />
            <div style={{
              position: 'fixed',
              left: Math.min(resolutionComposer.x, window.innerWidth - 800),
              top: Math.min(resolutionComposer.y, window.innerHeight - 600),
              zIndex: 9999,
            }}>
              <ResolutionPolicyComposer
                currentPolicy={currentPolicy}
                onApply={(policy) => handleSetResolution(resolutionComposer.key, policy)}
                onClear={() => handleClearResolution(resolutionComposer.key)}
                onClose={() => setResolutionComposer(null)}
              />
            </div>
          </>
        );
      })()}
      {constraintComposer && (() => {
        const fs = fieldSchemas.get(constraintComposer.key);
        return (
          <>
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
              onClick={() => setConstraintComposer(null)}
            />
            <div style={{
              position: 'fixed',
              left: Math.min(constraintComposer.x, window.innerWidth - 800),
              top: Math.min(constraintComposer.y, window.innerHeight - 600),
              zIndex: 9999,
            }}>
              <ConstraintComposer
                fieldKey={constraintComposer.key}
                existingConstraints={fs?.constraints ?? []}
                onAdd={(name, value) => handleAddConstraint(constraintComposer.key, name, value)}
                onRemove={(name) => handleRemoveConstraint(constraintComposer.key, name)}
                onClose={() => setConstraintComposer(null)}
              />
            </div>
          </>
        );
      })()}

      {/* Watched fields picker (lastModifiedTime columns) */}
      {watchedFieldsPicker && (() => {
        const fs = fieldSchemas.get(watchedFieldsPicker.key);
        const currentWatched: string[] = Array.isArray(fs?.typeDef?.value?.watchedFields)
          ? fs.typeDef.value.watchedFields
          : [];
        const pickerCols = orderedColumns.filter(c =>
          c.key !== watchedFieldsPicker.key &&
          c.key !== '_record' &&
          c.key !== '_last_updated'
        );
        return (
          <WatchedFieldsPicker
            x={watchedFieldsPicker.x}
            y={watchedFieldsPicker.y}
            fieldKey={watchedFieldsPicker.key}
            allColumns={pickerCols}
            currentWatched={currentWatched}
            onSave={(selected) => handleSaveWatchedFields(watchedFieldsPicker.key, selected)}
            onClose={() => setWatchedFieldsPicker(null)}
          />
        );
      })()}

      {/* Add column dialog */}
      {showAddColumn && (
        <AddColumnDialog scope={scope} onClose={() => setShowAddColumn(false)} />
      )}

      {/* Field editor side panel (opened by double-clicking a column header) */}
      {fieldPanelKey && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 9998, background: 'transparent' }}
            onClick={() => setFieldPanelKey(null)}
          />
          <div
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              zIndex: 9999,
              boxShadow: `-8px 0 30px ${theme.shadow}`,
              display: 'flex',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {(() => {
              const fs = fieldSchemas.get(fieldPanelKey);
              const activeSort = sorts.find((s) => s.field === fieldPanelKey);
              const isSystemCol = fieldPanelKey === '_record' || fieldPanelKey === '_last_updated';
              const resolvedType: string = fs?.typeDef?.value?.type
                ?? entityColumns.find((c) => c.key === fieldPanelKey)?.type
                ?? 'text';
              return (
                <SchemaFieldPanel
                  fieldKey={fieldPanelKey}
                  fieldSchema={fs}
                  scope={scope}
                  valueStats={fieldValueStats}
                  onClose={() => setFieldPanelKey(null)}
                  onSaveLabel={(label) => handleColumnRename(fieldPanelKey, label)}
                  onAddConstraint={(name, value) => handleAddConstraint(fieldPanelKey, name, value)}
                  onRemoveConstraint={(name) => handleRemoveConstraint(fieldPanelKey, name)}
                  onSetResolution={(policy) => handleSetResolution(fieldPanelKey, policy)}
                  onClearResolution={() => handleClearResolution(fieldPanelKey)}
                  sortDirection={activeSort?.direction ?? null}
                  isDisplayField={displayField === fieldPanelKey}
                  isSystemColumn={isSystemCol}
                  isLastModifiedTime={resolvedType === 'lastModifiedTime'}
                  onSortAsc={() => setSorts([{ id: crypto.randomUUID(), field: fieldPanelKey, direction: 'asc' }])}
                  onSortDesc={() => setSorts([{ id: crypto.randomUUID(), field: fieldPanelKey, direction: 'desc' }])}
                  onRemoveSort={() => setSorts(sorts.filter((s) => s.field !== fieldPanelKey))}
                  onFilterBy={() => {
                    const col = entityColumns.find((c) => c.key === fieldPanelKey);
                    setAdvancedFilters([
                      ...advancedFilters,
                      {
                        id: crypto.randomUUID(),
                        field: fieldPanelKey,
                        operator: col?.type === 'number' ? 'gt' : 'contains',
                        value: '',
                      },
                    ]);
                  }}
                  onChangeType={isSystemCol ? undefined : () => {
                    setColumnTypeSelector({ key: fieldPanelKey, x: 0, y: 0 });
                    setFieldPanelKey(null);
                  }}
                  onConfigureWatchedFields={resolvedType === 'lastModifiedTime' ? () => {
                    setWatchedFieldsPicker({ key: fieldPanelKey, x: 0, y: 0 });
                    setFieldPanelKey(null);
                  } : undefined}
                  onToggleDisplayField={isSystemCol ? undefined : async () => {
                    const newField = displayField === fieldPanelKey ? null : fieldPanelKey;
                    try {
                      await dispatch({
                        op: 'DEF',
                        target: scope,
                        operand: { _displayField: newField },
                        agent: `user:${session.userId}`,
                        ts: new Date().toISOString(),
                        acquired_ts: new Date().toISOString(),
                      });
                      setAuditableDisplayField(newField);
                    } catch { /* ignore */ }
                  }}
                  onHideColumn={() => {
                    sliceStore.toggleHiddenColumn(scope, fieldPanelKey);
                    setFieldPanelKey(null);
                  }}
                />
              );
            })()}
          </div>
        </>
      )}
      {showUpdateDetail && lastUpdate && (
        <TableUpdateDetail
          lastUpdate={lastUpdate}
          records={records}
          scope={scope}
          onClose={() => setShowUpdateDetail(false)}
          onSelectRecord={(target) => {
            setShowUpdateDetail(false);
            onSelectRecord(target);
          }}
          onClear={() => {
            setShowUpdateDetail(false);
            setLastUpdate(null);
          }}
          theme={theme}
        />
      )}
    </div>
  );
}

// --- Update Indicator ---
//
// A small pulsing badge rendered in the table toolbar that signals when the
// underlying record set has just been updated by sync. Clicking the badge
// opens the `TableUpdateDetail` modal so the user can see exactly which
// records were added, modified, or removed.

interface TableUpdateIndicatorProps {
  isUpdating: boolean;
  lastUpdate: {
    added: string[];
    modified: string[];
    removed: string[];
    ts: number;
    fresh: boolean;
  } | null;
  records: EoState[];
  scope: string;
  onOpenDetail: () => void;
  theme: Theme;
}

function TableUpdateIndicator({ isUpdating, lastUpdate, onOpenDetail, theme }: TableUpdateIndicatorProps) {
  // Nothing to show until we've either seen an in-flight update or captured a diff.
  if (!isUpdating && !lastUpdate) return null;

  const totalChanged = lastUpdate
    ? lastUpdate.added.length + lastUpdate.modified.length + lastUpdate.removed.length
    : 0;
  const pulse = isUpdating || !!lastUpdate?.fresh;

  // In-flight with no diff yet: show a muted "updating" pill.
  if (isUpdating && !lastUpdate) {
    return (
      <span
        title="Table is updating…"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: theme.textMuted,
          background: theme.bgMuted,
          padding: '2px 8px',
          borderRadius: 10,
          border: `1px solid ${theme.border}`,
        }}
      >
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: theme.accent,
            animation: 'eo-update-pulse 1.1s ease-in-out infinite',
          }}
        />
        Updating…
        <style>{`
          @keyframes eo-update-pulse {
            0%, 100% { opacity: 0.35; transform: scale(0.9); }
            50%      { opacity: 1;    transform: scale(1.15); }
          }
        `}</style>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenDetail}
      title={`Table updated — click to see ${totalChanged} changed record${totalChanged === 1 ? '' : 's'}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11,
        fontWeight: 500,
        color: theme.accent,
        background: theme.accentBg,
        padding: '2px 8px',
        borderRadius: 10,
        border: `1px solid ${theme.accentBorder}`,
        cursor: 'pointer',
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: theme.accent,
          animation: pulse ? 'eo-update-pulse 1.1s ease-in-out infinite' : 'none',
        }}
      />
      Updated
      {totalChanged > 0 && <span style={{ opacity: 0.75 }}>· {totalChanged}</span>}
      <style>{`
        @keyframes eo-update-pulse {
          0%, 100% { opacity: 0.35; transform: scale(0.9); }
          50%      { opacity: 1;    transform: scale(1.15); }
        }
      `}</style>
    </button>
  );
}

// --- Update Detail Popup ---
//
// Modal listing the records that changed in the most recent update. Entries
// are clickable — selecting one navigates to the record detail view so the
// user can audit the actual change.

interface TableUpdateDetailProps {
  lastUpdate: {
    added: string[];
    modified: string[];
    removed: string[];
    ts: number;
  };
  records: EoState[];
  scope: string;
  onClose: () => void;
  onSelectRecord: (target: string) => void;
  onClear: () => void;
  theme: Theme;
}

function TableUpdateDetail({ lastUpdate, records, onClose, onSelectRecord, onClear, theme }: TableUpdateDetailProps) {
  const byTarget = useMemo(() => {
    const m = new Map<string, EoState>();
    for (const r of records) m.set(r.target, r);
    return m;
  }, [records]);

  const displayName = (target: string): string => {
    const rec = byTarget.get(target);
    if (rec) {
      const name = resolveRecordName(rec);
      if (name) return name;
    }
    const parts = target.split('.');
    return parts[parts.length - 1] || target;
  };

  const sections: { label: string; color: string; items: string[]; clickable: boolean }[] = [
    { label: 'Added',    color: '#2b8a3e', items: lastUpdate.added,    clickable: true  },
    { label: 'Modified', color: theme.accent, items: lastUpdate.modified, clickable: true  },
    { label: 'Removed',  color: '#c92a2a', items: lastUpdate.removed,  clickable: false },
  ];

  // Close on Escape so the modal feels responsive.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const total = lastUpdate.added.length + lastUpdate.modified.length + lastUpdate.removed.length;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(480px, 90vw)',
          maxHeight: '80vh',
          background: theme.bgCard,
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          boxShadow: '0 16px 48px rgba(0,0,0,0.25)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: theme.textHeading }}>
              Table update
            </div>
            <div style={{ fontSize: 11, color: theme.textMuted, marginTop: 2 }}>
              {total} record{total === 1 ? '' : 's'} changed · {formatRelativeTime(new Date(lastUpdate.ts).toISOString())}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.textMuted,
              fontSize: 18,
              cursor: 'pointer',
              lineHeight: 1,
              padding: 4,
            }}
          >
            ×
          </button>
        </div>
        <div style={{ overflowY: 'auto', padding: '8px 0' }}>
          {sections.every(sec => sec.items.length === 0) && (
            <div style={{ padding: '16px', fontSize: 12, color: theme.textMuted }}>
              No changes detected.
            </div>
          )}
          {sections.map((sec) => {
            if (sec.items.length === 0) return null;
            return (
              <div key={sec.label} style={{ padding: '4px 16px 8px' }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: sec.color,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    padding: '6px 0',
                  }}
                >
                  {sec.label} · {sec.items.length}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {sec.items.map((target) => {
                    const name = displayName(target);
                    const content = (
                      <>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 4,
                            height: 4,
                            borderRadius: '50%',
                            background: sec.color,
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            flex: 1,
                            fontSize: 12,
                            color: theme.textHeading,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {name}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            color: theme.textMuted,
                            fontFamily: "'JetBrains Mono', monospace",
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: 180,
                          }}
                        >
                          {target}
                        </span>
                      </>
                    );
                    if (sec.clickable) {
                      return (
                        <button
                          key={target}
                          type="button"
                          onClick={() => onSelectRecord(target)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '6px 8px',
                            background: 'transparent',
                            border: `1px solid transparent`,
                            borderRadius: 4,
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = theme.bgMuted;
                            e.currentTarget.style.borderColor = theme.border;
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.borderColor = 'transparent';
                          }}
                        >
                          {content}
                        </button>
                      );
                    }
                    return (
                      <div
                        key={target}
                        title="Removed records can't be opened"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 8px',
                          opacity: 0.7,
                        }}
                      >
                        {content}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '10px 16px',
            borderTop: `1px solid ${theme.border}`,
            background: theme.bgMuted,
          }}
        >
          <button
            onClick={onClear}
            style={{
              fontSize: 11,
              padding: '4px 10px',
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              background: 'transparent',
              color: theme.textMuted,
              cursor: 'pointer',
            }}
          >
            Dismiss
          </button>
          <button
            onClick={onClose}
            style={{
              fontSize: 11,
              padding: '4px 10px',
              border: `1px solid ${theme.accentBorder}`,
              borderRadius: 4,
              background: theme.accent,
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Sortable Column Header ---

interface SortableColumnHeaderProps {
  col: ColumnDef;
  theme: Theme;
  thStyle: React.CSSProperties;
  sorts: SortRule[];
  renameCol: { key: string; value: string } | null;
  permissions?: ResolvedPermissions | null;
  isResizing: boolean;
  isAnyResizing: boolean;
  disabled: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: (val: string) => void;
  onCancelRename: () => void;
  onResizeStart: (startX: number) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
}

const DRAG_DEAD_ZONE_PX = 16; // suppress column drag near right edge (resize area)

function SortableColumnHeader({
  col, theme, thStyle, sorts, renameCol, permissions,
  isResizing, isAnyResizing, disabled, onContextMenu, onRename, onCancelRename, onResizeStart, onDoubleClick,
}: SortableColumnHeaderProps) {
  const effectivelyDisabled = disabled || isAnyResizing;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: col.key, disabled: effectivelyDisabled });

  // Wrap dnd-kit listeners to add a dead zone near the resize handle edge
  const filteredListeners = useMemo(() => {
    if (effectivelyDisabled || !listeners) return {};
    return Object.fromEntries(
      Object.entries(listeners).map(([key, handler]) => {
        if (key === 'onPointerDown') {
          return [key, (e: React.PointerEvent) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.right - e.clientX < DRAG_DEAD_ZONE_PX) return;
            (handler as (e: React.PointerEvent) => void)(e);
          }];
        }
        return [key, handler];
      })
    );
  }, [listeners, effectivelyDisabled]);

  const style: React.CSSProperties = {
    ...thStyle,
    cursor: effectivelyDisabled ? 'default' : 'grab',
    userSelect: 'none',
    position: 'sticky' as const,
    top: 0,
    transform: CSS.Transform.toString(transform ? { ...transform, y: 0 } : null),
    transition,
    opacity: isDragging ? 0.3 : 1,
    zIndex: isDragging ? 10 : 2,
    background: isDragging ? theme.bgHover : thStyle.background,
  };

  const isLocked = permissions?.locked_fields?.includes(col.key);

  return (
    <th
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...filteredListeners}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
    >
      {renameCol?.key === col.key ? (
        <input
          autoFocus
          defaultValue={renameCol.value}
          style={{
            fontSize: 11, fontWeight: 400, border: `1px solid ${theme.accent}`,
            borderRadius: 3, padding: '2px 4px', background: theme.bgCard,
            color: theme.text, outline: 'none', width: '100%',
            textTransform: 'none' as const,
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRename((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') onCancelRename();
          }}
          onBlur={(e) => onRename(e.target.value)}
        />
      ) : (
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, flex: 1 }}>
          {(() => {
            const typeInfo = COLUMN_TYPE_ICON_MAP.get(col.type as Parameters<typeof COLUMN_TYPE_ICON_MAP.get>[0]);
            if (!typeInfo) return null;
            const TypeIcon = typeInfo.icon;
            return <TypeIcon size={13} color={typeInfo.color} style={{ flexShrink: 0 }} />;
          })()}
          {isLocked && <LockIcon />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
            {col.label}
          </span>
          {sorts.find((s) => s.field === col.key) && (
            <span style={{ fontSize: 10, flexShrink: 0 }}>
              {sorts.find((s) => s.field === col.key)!.direction === 'asc' ? '\u25B4' : '\u25BE'}
            </span>
          )}
          <span className="col-header-chevron" style={{ fontSize: 10, color: theme.textMuted, opacity: 0, flexShrink: 0, marginLeft: 'auto', transition: 'opacity 0.1s' }}>▾</span>
        </span>
      )}
      {/* Resize handle — wide invisible hit area with 1px visible indicator */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: 8,
          height: '100%',
          cursor: 'col-resize',
          zIndex: 3,
          background: 'transparent',
          display: 'flex',
          alignItems: 'stretch',
          justifyContent: 'flex-end',
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onResizeStart(e.clientX);
        }}
        onMouseEnter={(e) => {
          const indicator = e.currentTarget.firstElementChild as HTMLElement;
          if (!isResizing && indicator) indicator.style.background = theme.accent;
        }}
        onMouseLeave={(e) => {
          const indicator = e.currentTarget.firstElementChild as HTMLElement;
          if (!isResizing && indicator) indicator.style.background = 'transparent';
        }}
      >
        <div
          style={{
            width: 3,
            height: '100%',
            background: isResizing ? theme.accent : 'transparent',
            borderRadius: 2,
            pointerEvents: 'none',
          }}
        />
      </div>
    </th>
  );
}

// --- Styles ---

function makeStyles(t: Theme): Record<string, React.CSSProperties> {
  return {
    container: {
      flex: 1,
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      background: t.bgCard,
    },
    toolbar: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap' as const,
      columnGap: 12,
      rowGap: 8,
      padding: '10px 20px',
      borderBottom: `0.5px solid ${t.border}`,
      background: t.bgCard,
      flexShrink: 0,
      minWidth: 0,
    },
    toolbarLeft: {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap' as const,
      columnGap: 8,
      rowGap: 8,
      minWidth: 0,
    },
    toolbarRight: {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap' as const,
      justifyContent: 'flex-end' as const,
      columnGap: 8,
      rowGap: 8,
      minWidth: 0,
      flex: '1 1 auto',
    },
    scopeName: {
      fontSize: 14,
      fontWeight: 500,
      color: t.textHeading,
    },
    recordCount: {
      fontSize: 12,
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 4,
    },
    schemaBadges: {
      display: 'inline-flex',
      gap: 4,
      marginLeft: 2,
    },
    schemaBadge: {
      fontSize: 10,
      fontWeight: 600,
      fontFamily: "'JetBrains Mono', monospace",
      color: t.textMuted,
      background: t.bgMuted,
      padding: '1px 6px',
      borderRadius: 4,
      letterSpacing: '0.02em',
    },
    addRecordBtn: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      height: 28,
      padding: '0 12px',
      fontSize: 12,
      fontWeight: 600,
      border: `1px solid ${t.accent}`,
      borderRadius: 6,
      background: t.accent,
      color: '#fff',
      cursor: 'pointer',
      whiteSpace: 'nowrap' as const,
      boxSizing: 'border-box' as const,
    },
    toggleBtn: {
      height: 28,
      fontSize: 11,
      padding: '0 10px',
      borderRadius: 4,
      cursor: 'pointer',
      fontWeight: 500,
      whiteSpace: 'nowrap' as const,
    },
    filterInput: {
      width: 140,
      height: 28,
      fontSize: 12,
      padding: '0 8px',
      border: `0.5px solid ${t.border}`,
      borderRadius: 4,
      background: t.bgCard,
      color: t.text,
      outline: 'none',
    },
    tableWrap: {
      flex: 1,
      overflowX: 'auto',
      overflowY: 'auto',
      willChange: 'scroll-position',
      contain: 'layout style paint' as React.CSSProperties['contain'],
    },
    table: {
      width: '100%',
      borderCollapse: 'collapse',
      fontSize: 12,
      color: t.textHeading,
    } as React.CSSProperties,
    th: {
      position: 'relative' as const,
      background: t.bgMuted,
      padding: '0 8px 0 10px',
      height: 32,
      textAlign: 'left' as const,
      fontSize: 12,
      fontWeight: 500,
      textTransform: 'none' as const,
      letterSpacing: '0',
      color: t.textSecondary,
      borderBottom: `1px solid ${t.border}`,
      borderRight: `1px solid ${t.border}`,
      whiteSpace: 'nowrap' as const,
      overflow: 'hidden' as const,
      textOverflow: 'ellipsis' as const,
    },
    td: {
      padding: '8px 8px 8px 12px',
      borderBottom: `1px solid ${t.borderLight}`,
      borderRight: `1px solid ${t.borderLight}`,
      verticalAlign: 'middle' as const,
      maxWidth: 300,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'normal' as const,
      wordBreak: 'break-word' as const,
    },
    emptyRow: {
      padding: '40px 16px',
      textAlign: 'center' as const,
      color: t.textMuted,
      fontSize: 12,
    },
  };
}
