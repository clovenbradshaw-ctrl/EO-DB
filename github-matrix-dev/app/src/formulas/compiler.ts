/**
 * Compiles an AST into an evaluatable function.
 * The compiled function takes field values and an EvalContext,
 * and returns the computed result.
 */

import type { ASTNode, EvalContext } from './types';
import { FORMULA_FUNCTIONS, FormulaError } from './functions';

type CompiledFormula = (fieldValues: Record<string, any>, ctx: EvalContext) => any;

export function compileAST(node: ASTNode): CompiledFormula {
  switch (node.type) {
    case 'NumberLiteral':
      return () => node.value;

    case 'StringLiteral':
      return () => node.value;

    case 'BlankLiteral':
      return () => null;

    case 'FieldRef': {
      const fieldName = node.fieldName;
      return (fieldValues, ctx) => {
        if (fieldName in fieldValues) return fieldValues[fieldName];
        const fieldId = ctx.fieldNameToId.get(fieldName);
        if (fieldId && fieldId in fieldValues) return fieldValues[fieldId];
        return undefined;
      };
    }

    case 'UnaryExpr': {
      const operand = compileAST(node.operand);
      return (fv, ctx) => {
        const val = operand(fv, ctx);
        if (node.operator === '-') {
          const n = typeof val === 'number' ? val : Number(val);
          return isNaN(n) ? null : -n;
        }
        return val;
      };
    }

    case 'BinaryExpr': {
      const left = compileAST(node.left);
      const right = compileAST(node.right);
      const op = node.operator;

      return (fv, ctx) => {
        const l = left(fv, ctx);
        const r = right(fv, ctx);
        return evalBinaryOp(op, l, r);
      };
    }

    case 'FunctionCall': {
      const name = node.name;
      const argCompilers = node.args.map(compileAST);

      // ISERROR wraps its argument in try-catch
      if (name === 'ISERROR') {
        return (fv, ctx) => {
          try {
            const val = argCompilers[0]?.(fv, ctx);
            return val instanceof FormulaError ? 1 : 0;
          } catch {
            return 1;
          }
        };
      }

      // IF should not evaluate both branches
      if (name === 'IF') {
        return (fv, ctx) => {
          const condition = argCompilers[0]?.(fv, ctx);
          if (isTruthy(condition)) {
            return argCompilers[1]?.(fv, ctx) ?? null;
          } else {
            return argCompilers[2]?.(fv, ctx) ?? null;
          }
        };
      }

      // SWITCH should not evaluate all branches
      if (name === 'SWITCH') {
        return (fv, ctx) => {
          if (argCompilers.length < 1) return null;
          const expr = argCompilers[0](fv, ctx);

          for (let i = 1; i + 1 < argCompilers.length; i += 2) {
            const pattern = argCompilers[i](fv, ctx);
            if (expr === pattern || String(expr) === String(pattern)) {
              return argCompilers[i + 1](fv, ctx);
            }
          }
          if (argCompilers.length >= 2 && (argCompilers.length - 1) % 2 === 1) {
            return argCompilers[argCompilers.length - 1](fv, ctx);
          }
          return null;
        };
      }

      const fn = FORMULA_FUNCTIONS[name];
      if (!fn) {
        return () => {
          throw new FormulaError(`Unknown function: ${name}`);
        };
      }

      return (fv, ctx) => {
        const args = argCompilers.map((c: CompiledFormula) => c(fv, ctx));
        try {
          return fn(args, ctx);
        } catch (e) {
          if (e instanceof FormulaError) throw e;
          throw new FormulaError(`Error in ${name}(): ${e instanceof Error ? e.message : String(e)}`);
        }
      };
    }

    default:
      return () => {
        throw new FormulaError(`Unknown AST node type: ${node.type}`);
      };
  }
}

// ─── Binary Operator Evaluation ──────────────────────────

function evalBinaryOp(op: string, left: any, right: any): any {
  switch (op) {
    case '&':
      return String(left ?? '') + String(right ?? '');
    case '+': return toNum(left) + toNum(right);
    case '-': return toNum(left) - toNum(right);
    case '*': return toNum(left) * toNum(right);
    case '/': {
      const divisor = toNum(right);
      if (divisor === 0) throw new FormulaError('#ERROR! Division by zero');
      return toNum(left) / divisor;
    }
    case '=': return left === right || String(left) === String(right) ? 1 : 0;
    case '!=': return left !== right && String(left) !== String(right) ? 1 : 0;
    case '<': return compare(left, right) < 0 ? 1 : 0;
    case '<=': return compare(left, right) <= 0 ? 1 : 0;
    case '>': return compare(left, right) > 0 ? 1 : 0;
    case '>=': return compare(left, right) >= 0 ? 1 : 0;
    default:
      throw new FormulaError(`Unknown operator: ${op}`);
  }
}

function toNum(v: any): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function isTruthy(v: any): boolean {
  return v != null && v !== '' && v !== 0 && v !== false;
}

function compare(a: any, b: any): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a ?? '').localeCompare(String(b ?? ''));
}
