/**
 * Type definitions for the EO formula engine.
 *
 * Formula fields are DEFs — the expression is stored as a definition.
 * The computed values are EVAs — ephemeral Horizon output, never persisted.
 */

// ─── Token Types ──────────────────────────────────────────
export type TokenType =
  | 'NUMBER' | 'STRING' | 'FIELD_REF' | 'FUNCTION'
  | 'OPERATOR' | 'LPAREN' | 'RPAREN' | 'COMMA'
  | 'NEWLINE' | 'EOF';

export interface Token {
  type: TokenType;
  value: string;
  position: number;
}

// ─── AST Node Types ───────────────────────────────────────
export type ASTNodeType =
  | 'NumberLiteral' | 'StringLiteral' | 'FieldRef'
  | 'BinaryExpr' | 'UnaryExpr' | 'FunctionCall'
  | 'BlankLiteral';

export interface ASTNode {
  type: ASTNodeType;
  [key: string]: any;
}

export interface NumberLiteral extends ASTNode {
  type: 'NumberLiteral';
  value: number;
}

export interface StringLiteral extends ASTNode {
  type: 'StringLiteral';
  value: string;
}

export interface FieldRef extends ASTNode {
  type: 'FieldRef';
  fieldName: string;
  resolvedId?: string;
}

export interface BinaryExpr extends ASTNode {
  type: 'BinaryExpr';
  operator: string;
  left: ASTNode;
  right: ASTNode;
}

export interface UnaryExpr extends ASTNode {
  type: 'UnaryExpr';
  operator: string;
  operand: ASTNode;
}

export interface FunctionCall extends ASTNode {
  type: 'FunctionCall';
  name: string;
  args: ASTNode[];
}

export interface BlankLiteral extends ASTNode {
  type: 'BlankLiteral';
}

// ─── Registry Types ───────────────────────────────────────
export interface FormulaField {
  fieldId: string;
  fieldName: string;
  formulaExpression: string;
  resultType?: string;
  fieldType: string;
  linkedTableId?: string;
  linkedFieldId?: string;
  rollupFunction?: string;
}

export interface ComputedValue {
  value: any;
  error?: string;
  stale?: boolean;
}

// ─── EO State Interface ──────────────────────────────────
export interface EoStateReader {
  get(target: string): { value: any } | undefined;
  getByPrefix(prefix: string): Map<string, { value: any }>;
}

// ─── Evaluation Context ──────────────────────────────────
export interface EvalContext {
  recordId: string;
  tableTarget: string;
  fieldNameToId: Map<string, string>;
  eoState: EoStateReader;
  now: () => Date;
}
