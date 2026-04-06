/**
 * Detail layout configuration — stored as a DEF on scope._schema._detail_layout.
 *
 * One canonical DEF per object type. Versioned, revertible, per-object-type.
 * Changing the layout dispatches a DEF event, same as any other schema change.
 *
 * The layout defines which sections appear, their order, which fields are
 * visible, and which columns are shown in each connection table.
 */

import type { ConnectionColumnDef } from './ConnectionsPanel';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface FieldsSectionConfig {
  type: 'fields';
  visible?: string[];  // visible field keys; undefined = show all
}

export interface ConnectionSectionConfig {
  type: 'connection';
  entity: string;      // collection key (e.g. "cases")
  columns: ConnectionColumnDef[];
  hidden?: boolean;
}

export interface HistorySectionConfig {
  type: 'history';
  hidden?: boolean;
}

export type SectionConfig = FieldsSectionConfig | ConnectionSectionConfig | HistorySectionConfig;

export type LayoutDisplayType = 'drawer' | 'modal';

export interface DetailLayout {
  layoutType?: LayoutDisplayType;
  sections: SectionConfig[];
}

// ─── Target path ────────────────────────────────────────────────────────────

/**
 * Build the target path for a detail layout DEF.
 * e.g. "import.clients._schema._detail_layout"
 */
export function detailLayoutTarget(scope: string): string {
  return `${scope}._schema._detail_layout`;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/** Build a default layout from the available connection types */
export function defaultLayout(connectionTypes: string[]): DetailLayout {
  const sections: SectionConfig[] = [
    { type: 'fields' },
  ];

  for (const entity of connectionTypes) {
    sections.push({
      type: 'connection',
      entity,
      columns: [{ key: 'name', label: 'Name' }],
    });
  }

  sections.push({ type: 'history' });

  return { sections } as DetailLayout;
}

// ─── Mutations ──────────────────────────────────────────────────────────────

/** Add a column to a connection section */
export function addColumn(
  layout: DetailLayout,
  entity: string,
  column: ConnectionColumnDef,
): DetailLayout {
  return {
    ...layout,
    sections: layout.sections.map(s => {
      if (s.type === 'connection' && s.entity === entity) {
        const existing = s.columns.find(c => c.key === column.key);
        if (existing) return s; // already present
        return { ...s, columns: [...s.columns, column] };
      }
      return s;
    }),
  };
}

/** Remove a column from a connection section */
export function removeColumn(
  layout: DetailLayout,
  entity: string,
  columnKey: string,
): DetailLayout {
  return {
    ...layout,
    sections: layout.sections.map(s => {
      if (s.type === 'connection' && s.entity === entity) {
        return { ...s, columns: s.columns.filter(c => c.key !== columnKey) };
      }
      return s;
    }),
  };
}

/** Toggle a section's hidden state */
export function toggleSectionHidden(
  layout: DetailLayout,
  entity: string,
): DetailLayout {
  return {
    ...layout,
    sections: layout.sections.map(s => {
      if (s.type === 'connection' && s.entity === entity) {
        return { ...s, hidden: !s.hidden };
      }
      return s;
    }),
  };
}

/** Set the layout display type (drawer vs full modal) */
export function setLayoutType(layout: DetailLayout, type: LayoutDisplayType): DetailLayout {
  return { ...layout, layoutType: type };
}

/** Set visible fields in the fields section */
export function setVisibleFields(layout: DetailLayout, fields: string[] | undefined): DetailLayout {
  return {
    ...layout,
    sections: layout.sections.map(s =>
      s.type === 'fields' ? { ...s, visible: fields } : s,
    ),
  };
}

/** Reorder sections by moving one from fromIndex to toIndex */
export function reorderSections(layout: DetailLayout, fromIndex: number, toIndex: number): DetailLayout {
  const sections = [...layout.sections];
  const [moved] = sections.splice(fromIndex, 1);
  sections.splice(toIndex, 0, moved);
  return { ...layout, sections };
}

/** Ensure a connection type has a section (for "+ Add section") */
export function addSection(
  layout: DetailLayout,
  entity: string,
): DetailLayout {
  const exists = layout.sections.some(
    s => s.type === 'connection' && s.entity === entity,
  );
  if (exists) return layout;

  // Insert before history
  const historyIdx = layout.sections.findIndex(s => s.type === 'history');
  const newSection: ConnectionSectionConfig = {
    type: 'connection',
    entity,
    columns: [{ key: 'name', label: 'Name' }],
  };

  const sections = [...layout.sections];
  if (historyIdx >= 0) {
    sections.splice(historyIdx, 0, newSection);
  } else {
    sections.push(newSection);
  }
  return { ...layout, sections };
}
