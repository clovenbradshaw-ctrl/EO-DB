import type { SortRule } from './SortPanel';
import type { FilterRule } from './filter-types';

// ---------------------------------------------------------------------------
// SliceType — the kind of visualization for a saved slice
// ---------------------------------------------------------------------------

export type SliceType = 'grid' | 'graph' | 'kanban' | 'calendar' | 'gallery' | 'schema' | 'record';

export const SLICE_TYPE_META: Record<SliceType, { label: string; icon: string }> = {
  grid: { label: 'Grid', icon: '\u229E' },
  graph: { label: 'Graph', icon: '\u2B21' },
  kanban: { label: 'Kanban', icon: '\u25A5' },
  calendar: { label: 'Calendar', icon: '\u25F7' },
  gallery: { label: 'Gallery', icon: '\u25A6' },
  schema: { label: 'Schema', icon: '\u2261' },
  record: { label: 'Record', icon: '\u25C9' },
};

// ---------------------------------------------------------------------------
// TableSliceConfig — the full column/filter/sort layout state for a table slice
// ---------------------------------------------------------------------------

export interface TableSliceConfig {
  columnOrder: string[];                // ordered column keys
  columnWidths: Record<string, number>; // key → px width
  hiddenColumns: string[];
  sorts: SortRule[];
  filters: FilterRule[];
  filterConjunction: 'AND' | 'OR';
  showLastUpdated: boolean;
  rowHeight?: 'compact' | 'default' | 'tall';
  cellOverflow?: 'clip' | 'wrap';
  profileFields?: string[];
  /** Field key used as the record's display name (falls back to rec.value.name / target segment) */
  displayField?: string;
  /** Field key used to group records into kanban columns */
  kanbanField?: string;
  /** Date field key used to position records on the calendar grid */
  calendarField?: string;
  /** When true, show raw field IDs instead of display names. Defaults to false. */
  showFieldIds?: boolean;
  /** Target path of the pinned record (only used when sliceType === 'record') */
  recordTarget?: string;
}

// ---------------------------------------------------------------------------
// SavedSlice — an INS entity stored at {scope}._slices.{sliceId}
// ---------------------------------------------------------------------------

export interface SavedSlice {
  id: string;
  name: string;
  scope: string;                        // which table this slice belongs to
  sliceType?: SliceType;                // visualization type (defaults to 'grid')
  config: TableSliceConfig;
  visibility: 'private' | 'shared';
  createdBy: string;                    // Matrix user ID
  createdAt: string;
  updatedAt: string;
  roomId?: string;                      // Matrix room for private slices
  /** User type IDs that can see this slice. Empty/absent = visible to all. */
  visibleToTypes?: string[];
  /** User type IDs for which this slice is read-only (can see but not edit). */
  readOnlyForTypes?: string[];
}

// ---------------------------------------------------------------------------
// SliceSig — local-only signal stored in localStorage (pre-save state)
// Keyed by `eo-slice-sig:{scope}`
// ---------------------------------------------------------------------------

export interface SliceSig {
  scope: string;
  activeSliceId: string | null;          // null = default/unsaved
  config: TableSliceConfig;
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createDefaultConfig(): TableSliceConfig {
  return {
    columnOrder: [],
    columnWidths: {},
    hiddenColumns: ['_record'],
    sorts: [],
    filters: [],
    filterConjunction: 'AND',
    showLastUpdated: true,
    cellOverflow: 'clip',
  };
}

/** Default column width by type */
export function defaultColumnWidth(type: string): number {
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'autoNumber':
    case 'count':
      return 120;
    case 'rating':
    case 'boolean':
      return 80;
    case 'duration':
      return 110;
    case 'date':
    case 'createdTime':
    case 'lastModifiedTime':
    case 'select':
    case 'multiSelect':
      return 150;
    case 'email':
    case 'url':
    case 'phone':
      return 180;
    case 'attachment':
    case 'linkedRecord':
    case 'link':
    case 'relationship':
    case 'formula':
    case 'rollup':
    case 'lookup':
    case 'createdBy':
    case 'lastModifiedBy':
      return 200;
    default: return 200;
  }
}

export const MIN_COLUMN_WIDTH = 60;
