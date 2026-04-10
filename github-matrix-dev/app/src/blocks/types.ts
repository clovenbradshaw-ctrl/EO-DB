import type { FilterRule } from '../components/filter-types';

// ---------------------------------------------------------------------------
// Data Binding — universal item selection for all blocks
// ---------------------------------------------------------------------------

/** How items are selected */
export type SelectionMode = 'hierarchy' | 'depth' | 'type' | 'connection' | 'query';

export interface DataBinding {
  mode: SelectionMode;

  // --- hierarchy mode ---
  /** Target path selected in the tree (e.g., "app.tblClients") */
  target?: string;
  /** Whether to include descendants or just direct children */
  depth?: 'children' | 'all';

  // --- depth mode ---
  /** Absolute depth level (e.g., 3 = all records across all tables) */
  level?: number;
  /** Optional root to scope the depth query */
  root?: string;

  // --- type mode ---
  /** _type value to match (e.g., "Person", "Case") */
  typeFilter?: string;
  /** Optional root to scope the type query */
  typeRoot?: string;

  // --- connection mode ---
  /** Field chain expression, e.g. "@.cases" or "@.assigned_to.cases" */
  fieldChain?: string;

  // --- query mode (power user) ---
  /** Raw EOQL or SQL string */
  query?: string;
  /** Query language */
  queryLang?: 'eo' | 'sql';

  // --- shared ---
  /** Additional filter rules applied after selection */
  filters?: FilterRule[];
  /** Field to extract (for single-value bindings like heading text) */
  field?: string;
}

// ---------------------------------------------------------------------------
// Block Type Discriminators
// ---------------------------------------------------------------------------

export type BlockId = string; // crypto.randomUUID()

export type BlockType =
  // Layout
  | 'section' | 'columns' | 'tabs' | 'divider' | 'spacer'
  // Text
  | 'heading' | 'paragraph' | 'callout' | 'quote' | 'toggle'
  | 'bulleted-list' | 'numbered-list' | 'checklist' | 'code-block'
  // Media
  | 'image' | 'file' | 'embed' | 'web-bookmark'
  // Data
  | 'table' | 'list' | 'metric' | 'cards-grid' | 'detail' | 'kanban' | 'calendar'
  | 'chart' | 'summary-kpi' | 'timeline' | 'map' | 'gallery'
  // Record context
  | 'record'
  // Form / Input
  | 'form' | 'filter-bar' | 'search' | 'button'
  // Interaction
  | 'comments' | 'activity-log' | 'status-indicator'
  // Reference / Reuse
  | 'link-to-view' | 'synced-block' | 'template';

export type BlockCategory =
  | 'layout' | 'text' | 'media' | 'data' | 'form' | 'interaction' | 'reference';

// ---------------------------------------------------------------------------
// Block Node — the recursive tree structure
// ---------------------------------------------------------------------------

export interface BlockNode {
  id: BlockId;
  type: BlockType;
  props: Record<string, any>;
  /** Nested blocks for simple containers (Section, Toggle, Callout) */
  children?: BlockNode[];
  /** Named slots for multi-pane containers (Columns: 'col-0'; Tabs: 'tab-0') */
  slots?: Record<string, BlockNode[]>;
}

// ---------------------------------------------------------------------------
// Page Types — Softr-style page classification
// ---------------------------------------------------------------------------

/** What kind of page/view this is */
export type PageType = 'page' | 'list' | 'record';

/** Collection binding for list and record pages */
export interface RecordSource {
  /** The collection scope (e.g., "app.tblClients") */
  scope: string;
  /** For list pages: which record page view ID to open on row click */
  recordPageId?: string;
  /** Binding used to select the collection */
  binding?: DataBinding;
}

// ---------------------------------------------------------------------------
// View Definition — stored as DEF operand on views.<viewId>
// ---------------------------------------------------------------------------

export interface ViewDefinition {
  name: string;
  slug?: string;
  icon?: string;
  blocks: BlockNode[];

  /** Page type: 'page' (static), 'list' (collection), 'record' (profile) */
  pageType?: PageType;

  /** For list/record pages: which collection this page is bound to */
  recordSource?: RecordSource;

  dataSource?: {
    scope: string;
    filters?: FilterRule[];
  };

  /**
   * Persona visibility — mirrors SavedSlice.visibleToTypes.
   * Undefined or empty = visible to all personas.
   * When set, only these user type IDs can see the view; admins (pl>=50)
   * always bypass this restriction.
   */
  visibleToTypes?: string[];
  /**
   * Persona read-only marker — mirrors SavedSlice.readOnlyForTypes.
   * User types listed here can see the view but not edit it.
   */
  readOnlyForTypes?: string[];

  createdAt: string;
  updatedAt: string;
}

/**
 * Helper — is this view visible to the given persona?
 *
 * - If the view has no visibleToTypes restriction → visible to everyone.
 * - If the current user is an admin (canManage=true) → visible regardless.
 * - Otherwise, the active persona must be in the visibleToTypes list.
 *
 * Mirrors the pattern used for SavedSlice in slice-store.ts.
 */
export function isViewVisibleToPersona(
  def: Pick<ViewDefinition, 'visibleToTypes'> | null | undefined,
  activePersona: string | null,
  canManage: boolean,
): boolean {
  if (!def) return true;
  if (canManage) return true;
  const restriction = def.visibleToTypes;
  if (!restriction || restriction.length === 0) return true;
  if (!activePersona) return false;
  return restriction.includes(activePersona);
}

// ---------------------------------------------------------------------------
// Per-Block Prop Interfaces (Phase 1 blocks)
// ---------------------------------------------------------------------------

export interface SectionProps {
  title?: string;
  collapsed?: boolean;
  background?: string;
  borderVisible?: boolean;
  padding?: number;
  /** Data binding — sets the @ context for child blocks */
  binding?: DataBinding;
}

export interface ColumnsProps {
  count: number;             // 2, 3, or 4
  ratios: number[];          // e.g. [1, 2] for 1:2 split
  gap: number;               // px between columns
  stackOnMobile: boolean;
  verticalAlign: 'top' | 'center' | 'bottom';
}

export interface DividerProps {
  color?: string;
  thickness?: number;
  margin?: number;
}

export interface SpacerProps {
  height: number;            // px
}

export interface HeadingProps {
  level: 1 | 2 | 3;
  text: string;
  alignment: 'left' | 'center';
  /** Data binding — e.g. "@.name" to pull text from context item */
  binding?: DataBinding;
}

export interface ParagraphProps {
  text: string;
  alignment: 'left' | 'center' | 'right';
  /** Data binding — e.g. "@.description" to pull text from context item */
  binding?: DataBinding;
}

export interface TableBlockProps {
  scope: string;             // target prefix, e.g. "demo_space.clients"
  visibleColumns?: string[];
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  searchEnabled?: boolean;
  searchFields?: string[];
  pageSize?: number;
  rowClickAction?: 'none' | 'detail' | 'url';
  rowClickTarget?: string;
  emptyText?: string;
  /** Data binding — replaces scope when present */
  binding?: DataBinding;
}

export interface MetricBlockProps {
  title?: string;
  formula: 'COUNT' | 'SUM';
  field?: string;
  color?: string;
  prefix?: string;
  scope?: string;
  /** Data binding — selects items to aggregate */
  binding?: DataBinding;
}

export interface ListBlockProps {
  title?: string;
  primary?: string;
  secondary?: string;
  scope?: string;
  emptyText?: string;
  /** Data binding — replaces scope when present */
  binding?: DataBinding;
}

export interface RecordBlockProps {
  /** Target path of the specific record, e.g. "app.tblClients.rec_001" */
  recordTarget: string;
  /** Display the record header card */
  showHeader?: boolean;
  /** Which fields to display in the header */
  headerFields?: string[];
  /** Data binding — allows picking a record via any selection mode */
  binding?: DataBinding;
}

export interface CalendarBlockProps {
  /** Fallback scope if binding is not set. */
  scope?: string;
  /** Data binding — replaces scope when present. */
  binding?: DataBinding;
  /** Field key on each record holding the event start (ISO string). */
  dateField: string;
  /** Optional field key for event end (ISO string). */
  endDateField?: string;
  /** Field key holding the event display title. */
  titleField: string;
  /** Optional field key providing a CSS color. */
  colorField?: string;
  /** Which sub-view to render. */
  viewMode: 'month' | 'week' | 'day' | 'agenda';
  /** 0 = Sunday-start, 1 = Monday-start. */
  startDay?: 0 | 1;
  /** Text to show when no events match. */
  emptyText?: string;
}

export interface ButtonProps {
  label: string;
  style: 'primary' | 'secondary' | 'danger' | 'ghost';
  size: 'small' | 'default' | 'large';
  icon?: string;
  action: 'navigate' | 'open-form' | 'create-record' | 'update-field' | 'open-url' | 'export';
  actionTarget?: string;     // view ID, URL, or scope depending on action
  actionPayload?: Record<string, any>;
  confirmationMessage?: string;
  visible?: boolean;
  /** Data binding — for action target resolution */
  binding?: DataBinding;
}
