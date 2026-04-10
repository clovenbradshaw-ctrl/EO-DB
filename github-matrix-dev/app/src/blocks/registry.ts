import type { BlockType, BlockCategory, BlockNode } from './types';

// ---------------------------------------------------------------------------
// Block Registration — metadata for each block type
// ---------------------------------------------------------------------------

export interface BlockRegistration {
  type: BlockType;
  category: BlockCategory;
  label: string;
  icon: string;                        // single character or emoji placeholder
  defaultProps: () => Record<string, any>;
  acceptsChildren: boolean;
  acceptsSlots: string[] | null;       // named slot keys, or null if no slots
}

// ---------------------------------------------------------------------------
// Registry map
// ---------------------------------------------------------------------------

const registry = new Map<BlockType, BlockRegistration>();

function register(reg: BlockRegistration) {
  registry.set(reg.type, reg);
}

// --- Layout ---

register({
  type: 'section',
  category: 'layout',
  label: 'Section',
  icon: '▢',
  defaultProps: () => ({ title: '', collapsed: false, borderVisible: true, padding: 16 }),
  acceptsChildren: true,
  acceptsSlots: null,
});

register({
  type: 'columns',
  category: 'layout',
  label: 'Columns',
  icon: '▥',
  defaultProps: () => ({ count: 2, ratios: [1, 1], gap: 16, stackOnMobile: true, verticalAlign: 'top' }),
  acceptsChildren: false,
  acceptsSlots: ['col-0', 'col-1'],
});

register({
  type: 'divider',
  category: 'layout',
  label: 'Divider',
  icon: '─',
  defaultProps: () => ({ thickness: 1, margin: 16 }),
  acceptsChildren: false,
  acceptsSlots: null,
});

register({
  type: 'spacer',
  category: 'layout',
  label: 'Spacer',
  icon: '↕',
  defaultProps: () => ({ height: 24 }),
  acceptsChildren: false,
  acceptsSlots: null,
});

// --- Text ---

register({
  type: 'heading',
  category: 'text',
  label: 'Heading',
  icon: 'H',
  defaultProps: () => ({ level: 2, text: 'Heading', alignment: 'left' }),
  acceptsChildren: false,
  acceptsSlots: null,
});

register({
  type: 'paragraph',
  category: 'text',
  label: 'Paragraph',
  icon: '¶',
  defaultProps: () => ({ text: '', alignment: 'left' }),
  acceptsChildren: false,
  acceptsSlots: null,
});

// --- Data ---

register({
  type: 'table',
  category: 'data',
  label: 'Table',
  icon: '⊞',
  defaultProps: () => ({
    scope: '',
    visibleColumns: [],
    sortBy: '',
    sortDirection: 'asc',
    searchEnabled: true,
    pageSize: 25,
    rowClickAction: 'none',
    emptyText: 'No records found',
  }),
  acceptsChildren: false,
  acceptsSlots: null,
});

register({
  type: 'metric',
  category: 'data',
  label: 'Metric',
  icon: '#',
  defaultProps: () => ({
    title: 'Metric',
    formula: 'COUNT',
    field: '',
    color: '',
    prefix: '',
    scope: '',
  }),
  acceptsChildren: false,
  acceptsSlots: null,
});

register({
  type: 'list',
  category: 'data',
  label: 'List',
  icon: '☰',
  defaultProps: () => ({
    title: 'List',
    primary: 'name',
    secondary: '',
    scope: '',
    emptyText: 'No data',
  }),
  acceptsChildren: false,
  acceptsSlots: null,
});

register({
  type: 'calendar',
  category: 'data',
  label: 'Calendar',
  icon: 'C',
  defaultProps: () => ({
    scope: '',
    dateField: 'start',
    endDateField: 'end',
    titleField: 'summary',
    viewMode: 'month',
    startDay: 0,
    emptyText: 'No events',
  }),
  acceptsChildren: false,
  acceptsSlots: null,
});

// --- Record ---

register({
  type: 'record',
  category: 'data',
  label: 'Record',
  icon: '◉',
  defaultProps: () => ({
    recordTarget: '',
    showHeader: true,
    headerFields: [],
  }),
  acceptsChildren: true,
  acceptsSlots: null,
});

// --- Form / Input ---

register({
  type: 'button',
  category: 'form',
  label: 'Button',
  icon: '▶',
  defaultProps: () => ({
    label: 'Button',
    style: 'primary',
    size: 'default',
    action: 'navigate',
    actionTarget: '',
  }),
  acceptsChildren: false,
  acceptsSlots: null,
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getRegistration(type: BlockType): BlockRegistration | undefined {
  return registry.get(type);
}

export function getAllRegistrations(): BlockRegistration[] {
  return Array.from(registry.values());
}

export function getRegistrationsByCategory(category: BlockCategory): BlockRegistration[] {
  return getAllRegistrations().filter((r) => r.category === category);
}

/** Create a new BlockNode from a registered type with default props */
export function createBlock(type: BlockType): BlockNode {
  const reg = registry.get(type);
  if (!reg) throw new Error(`Unknown block type: ${type}`);

  const node: BlockNode = {
    id: crypto.randomUUID(),
    type,
    props: reg.defaultProps(),
  };

  if (reg.acceptsChildren) {
    node.children = [];
  }

  if (reg.acceptsSlots) {
    node.slots = {};
    for (const slotKey of reg.acceptsSlots) {
      node.slots[slotKey] = [];
    }
  }

  return node;
}

export { registry };
