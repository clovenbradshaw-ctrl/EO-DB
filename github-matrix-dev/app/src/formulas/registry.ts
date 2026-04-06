/**
 * FormulaRegistry: manages all formula fields for a table.
 * Builds a dependency graph, topologically sorts formulas,
 * compiles each, and evaluates them in dependency order.
 */

import type { FormulaField, EvalContext, ComputedValue } from './types';
import { parseFormula, extractFieldRefs } from './parser';
import { compileAST } from './compiler';
import { FormulaError } from './functions';

type CompiledFormula = (fieldValues: Record<string, any>, ctx: EvalContext) => any;

interface CompiledEntry {
  field: FormulaField;
  compiled: CompiledFormula;
  dependencies: string[];
}

export class FormulaRegistry {
  private entries: Map<string, CompiledEntry> = new Map();
  private evaluationOrder: string[] = [];
  private fieldNameToId: Map<string, string> = new Map();

  register(fields: FormulaField[], allFieldNames: Map<string, string>): void {
    this.entries.clear();
    this.fieldNameToId = allFieldNames;

    for (const field of fields) {
      if (!field.formulaExpression) continue;

      try {
        const ast = parseFormula(field.formulaExpression);
        const compiled = compileAST(ast);
        const dependencies = extractFieldRefs(field.formulaExpression);

        this.entries.set(field.fieldId, {
          field,
          compiled,
          dependencies,
        });
      } catch (e) {
        this.entries.set(field.fieldId, {
          field,
          compiled: () => { throw new FormulaError(`Parse error: ${e instanceof Error ? e.message : String(e)}`); },
          dependencies: [],
        });
      }
    }

    this.evaluationOrder = this.topologicalSort();
  }

  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const result: string[] = [];

    const nameToFormulaId = new Map<string, string>();
    for (const [fieldId, entry] of this.entries) {
      nameToFormulaId.set(entry.field.fieldName, fieldId);
    }

    const visit = (fieldId: string) => {
      if (visited.has(fieldId)) return;
      if (visiting.has(fieldId)) {
        console.warn(`Formula circular dependency involving ${fieldId}`);
        return;
      }

      visiting.add(fieldId);

      const entry = this.entries.get(fieldId);
      if (entry) {
        for (const depName of entry.dependencies) {
          const depId = nameToFormulaId.get(depName);
          if (depId && this.entries.has(depId)) {
            visit(depId);
          }
        }
      }

      visiting.delete(fieldId);
      visited.add(fieldId);
      result.push(fieldId);
    };

    for (const fieldId of this.entries.keys()) {
      visit(fieldId);
    }

    return result;
  }

  computeRecord(
    _recordId: string,
    storedFieldValues: Record<string, any>,
    ctx: EvalContext
  ): Map<string, ComputedValue> {
    void _recordId;
    const results = new Map<string, ComputedValue>();
    const values = { ...storedFieldValues };

    for (const fieldId of this.evaluationOrder) {
      const entry = this.entries.get(fieldId);
      if (!entry) continue;

      try {
        const result = entry.compiled(values, ctx);
        results.set(fieldId, { value: result });
        // Make the result available for downstream formulas
        values[fieldId] = result;
        values[entry.field.fieldName] = result;
      } catch (e) {
        const errorMsg = e instanceof FormulaError ? e.message :
          e instanceof Error ? e.message : String(e);
        results.set(fieldId, { value: null, error: errorMsg });
        values[fieldId] = null;
        values[entry.field.fieldName] = null;
      }
    }

    return results;
  }

  getDependents(fieldNameOrId: string): string[] {
    const dependents: string[] = [];
    const fieldName = this.fieldNameToId.has(fieldNameOrId)
      ? fieldNameOrId
      : [...this.fieldNameToId.entries()].find(([, id]) => id === fieldNameOrId)?.[0];

    if (!fieldName) return [];

    for (const [fieldId, entry] of this.entries) {
      if (entry.dependencies.includes(fieldName)) {
        dependents.push(fieldId);
      }
    }
    return dependents;
  }

  get size(): number {
    return this.entries.size;
  }
}
