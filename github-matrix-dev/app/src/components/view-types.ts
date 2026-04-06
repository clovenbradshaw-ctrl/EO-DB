import type { SortRule } from './SortPanel';
import type { FilterRule } from './filter-types';

// ---------------------------------------------------------------------------
// ViewType — the kind of visualization for a saved view
// ---------------------------------------------------------------------------

export type ViewType = 'grid' | 'graph' | 'kanban' | 'calendar' | 'gallery' | 'schema';

export const VIEW_TYPE_META: Record<ViewType, { label: string; icon: string }> = {
  grid: { label: 'Grid', icon: '\u229E' },
  graph: { label: 'Graph', icon: '\u2B21' },
  kanban: { label: 'Kanban', icon: '\u25A5' },
  calendar: { label: 'Calendar', icon: '\u25F7' },
  gallery: { label: 'Gallery', icon: '\u25A6' },
  schema: { label: 'Schema', icon: '\u2261' },
};

// ---------------------------------------------------------------------------
// TableViewConfig — the full column/filter/sort layout state for a table view
// ---------------------------------------------------------------------------

export interface TableViewConfig {
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
}

// ---------------------------------------------------------------------------
// SavedView — an INS entity stored at {scope}._views.{viewId}
// ---------------------------------------------------------------------------

export interface SavedView {
  id: string;
  name: string;
  scope: string;                        // which table this view belongs to
  viewType?: ViewType;                  // visualization type (defaults to 'grid')
  config: TableViewConfig;
  visibility: 'private' | 'shared';
  createdBy: string;                    // Matrix user ID
  createdAt: string;
  updatedAt: string;
  roomId?: string;                      // Matrix room for private views
}

// ---------------------------------------------------------------------------
// ViewSig — local-only signal stored in localStorage (pre-save state)
// Keyed by `eo-view-sig:{scope}`
// ---------------------------------------------------------------------------

export interface ViewSig {
  scope: string;
  activeViewId: string | null;          // null = default/unsaved
  config: TableViewConfig;
  dirty: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createDefaultConfig(): TableViewConfig {
  return {
    columnOrder: [],
    columnWidths: {},
    hiddenColumns: ['_record'],
    sorts: [],
    filters: [],
    filterConjunction: 'AND',
    showLastUpdated: true,
  };
}

/** Default column width by type */
export function defaultColumnWidth(type: string): number {
  switch (type) {
    case 'number': return 120;
    case 'boolean': return 80;
    case 'date': return 150;
    case 'select': return 150;
    case 'object': return 200;
    default: return 200;
  }
}

export const MIN_COLUMN_WIDTH = 60;
