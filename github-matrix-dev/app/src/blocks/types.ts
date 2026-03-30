import type { FilterRule } from '../components/filter-types';

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
  | 'table' | 'list' | 'cards-grid' | 'detail' | 'kanban' | 'calendar'
  | 'chart' | 'summary-kpi' | 'timeline' | 'map' | 'gallery'
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
// View Definition — stored as DEF operand on views.<viewId>
// ---------------------------------------------------------------------------

export interface ViewDefinition {
  name: string;
  icon?: string;
  blocks: BlockNode[];
  dataSource?: {
    scope: string;
    filters?: FilterRule[];
  };
  createdAt: string;
  updatedAt: string;
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
}

export interface ParagraphProps {
  text: string;
  alignment: 'left' | 'center' | 'right';
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
}
