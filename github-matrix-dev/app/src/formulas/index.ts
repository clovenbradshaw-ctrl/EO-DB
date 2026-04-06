/**
 * Public API for the EO formula engine.
 */

// Core engine
export { tokenize } from './tokenizer';
export { parseFormula, extractFieldRefs } from './parser';
export { compileAST } from './compiler';
export { FORMULA_FUNCTIONS, FormulaError } from './functions';
export { FormulaRegistry } from './registry';

// EO state integration
export { initializeFormulas, computeRecordFormulas, resolveLookup, resolveRollup } from './integration';

// React hook
export { useFormulas } from './useFormulas';

// Types
export type {
  Token, TokenType, ASTNode, FormulaField,
  ComputedValue, EvalContext, EoStateReader
} from './types';
