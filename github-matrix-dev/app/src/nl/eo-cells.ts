/**
 * The 27 EO semantic cells — Mode × Domain × Object.
 *
 * Source of truth: `/nl/build.md` §2 (27-cell coordinate map) and the
 * `OP_MAP` constant in `/nl/generate_centroids.py`.
 *
 * A classification result is a pointer into this array (by `cell_id`),
 * plus a confidence score against the nearest-centroid lookup.
 */

import type { Operator } from '../db/types';

export type Mode = 'Differentiating' | 'Relating' | 'Generating';
export type Domain = 'Existence' | 'Structure' | 'Significance';
export type ObjectLevel = 'Condition' | 'Entity' | 'Pattern';

export interface EOCell {
  /** Stable machine id, e.g. "NUL_Clearing_Void". Used as anchor infix. */
  cell_id: string;
  /** Human-readable key, e.g. "NUL(Clearing, Void)". */
  cell_key: string;
  operator: Operator;
  resolution: string; // e.g. "Clearing" — verb face of the cell
  site: string;       // e.g. "Void"     — noun face of the cell
  mode: Mode;
  domain: Domain;
  object: ObjectLevel;
}

/** Operator → {mode, domain} — matches OP_MAP in generate_centroids.py. */
export const OP_FACETS: Record<Operator, { mode: Mode; domain: Domain }> = {
  NUL: { mode: 'Differentiating', domain: 'Existence' },
  SIG: { mode: 'Relating',        domain: 'Existence' },
  INS: { mode: 'Generating',      domain: 'Existence' },
  SEG: { mode: 'Differentiating', domain: 'Structure' },
  CON: { mode: 'Relating',        domain: 'Structure' },
  SYN: { mode: 'Generating',      domain: 'Structure' },
  EVA: { mode: 'Differentiating', domain: 'Significance' },
  DEF: { mode: 'Relating',        domain: 'Significance' },
  REC: { mode: 'Generating',      domain: 'Significance' },
};

/**
 * Base 9 operator → (resolution, site) pairs for the Object=Condition axis.
 * The full 27 are produced by crossing with Object ∈ {Condition, Entity, Pattern}.
 */
const BASE_9: Array<{ operator: Operator; resolution: string; site: string }> = [
  { operator: 'NUL', resolution: 'Clearing', site: 'Void'     },
  { operator: 'SIG', resolution: 'Binding',  site: 'Entity'   },
  { operator: 'INS', resolution: 'Making',   site: 'Pattern'  },
  { operator: 'SEG', resolution: 'Clearing', site: 'Field'    },
  { operator: 'CON', resolution: 'Binding',  site: 'Link'     },
  { operator: 'SYN', resolution: 'Making',   site: 'Network'  },
  { operator: 'EVA', resolution: 'Clearing', site: 'Lens'     },
  { operator: 'DEF', resolution: 'Binding',  site: 'Paradigm' },
  { operator: 'REC', resolution: 'Making',   site: 'Paradigm' },
];

const OBJECT_LEVELS: ObjectLevel[] = ['Condition', 'Entity', 'Pattern'];

/** The full 27 cells, in stable deterministic order. */
export const EO_CELLS: EOCell[] = (() => {
  const cells: EOCell[] = [];
  for (const obj of OBJECT_LEVELS) {
    for (const base of BASE_9) {
      const facets = OP_FACETS[base.operator];
      const cell_key = `${base.operator}(${base.resolution}, ${base.site})`;
      const cell_id = cell_key
        .replace('(', '_')
        .replace(')', '')
        .replace(', ', '_')
        .replace(/ /g, '_');
      cells.push({
        cell_id: obj === 'Condition' ? cell_id : `${cell_id}__${obj}`,
        cell_key: obj === 'Condition' ? cell_key : `${cell_key}[${obj}]`,
        operator: base.operator,
        resolution: base.resolution,
        site: base.site,
        mode: facets.mode,
        domain: facets.domain,
        object: obj,
      });
    }
  }
  return cells;
})();

export function cellById(cell_id: string): EOCell | null {
  return EO_CELLS.find((c) => c.cell_id === cell_id) ?? null;
}

export function cellByKey(cell_key: string): EOCell | null {
  return EO_CELLS.find((c) => c.cell_key === cell_key) ?? null;
}

/** Short display label, e.g. "NUL · Clearing/Void · Condition". */
export function cellLabel(c: EOCell): string {
  return `${c.operator} · ${c.resolution}/${c.site} · ${c.object}`;
}
