/**
 * Airtable-style formula engine.
 *
 * Tokenizer → Parser → Evaluator pipeline that supports:
 *   - Arithmetic: + - * / % ^
 *   - Comparison: = != < > <= >=
 *   - String concat: &
 *   - Logical: AND() OR() NOT() IF()
 *   - Math: SUM() ROUND() FLOOR() CEILING() ABS() SQRT() POWER() LOG() EXP() MOD()
 *           MIN() MAX() INT() EVEN() ODD()
 *   - Text: CONCATENATE() LEFT() RIGHT() MID() LEN() TRIM() LOWER() UPPER()
 *           SUBSTITUTE() FIND() SEARCH() REPLACE() REPT() T() EXACT() ENCODE_URL_COMPONENT()
 *   - Date: TODAY() NOW() DATETIME_DIFF() DATETIME_FORMAT() DATETIME_PARSE()
 *           DATEADD() DATESTR() TIMESTR() YEAR() MONTH() DAY() HOUR() MINUTE()
 *           SECOND() WEEKDAY() WEEKNUM() IS_BEFORE() IS_AFTER() IS_SAME()
 *           CREATED_TIME() LAST_MODIFIED_TIME() SET_TIMEZONE() TONOW() FROMNOW()
 *   - Logical: SWITCH() TRUE() FALSE() BLANK() ERROR()
 *   - Info: RECORD_ID() COUNTA() COUNT() COUNTALL()
 *   - Array: ARRAYCOMPACT() ARRAYFLATTEN() ARRAYJOIN() ARRAYSLICE() ARRAYUNIQUE()
 *
 * Field references use `{Field Name}` syntax like Airtable.
 */

// ─── Token types ──────────────────────────────────────────────────────────

type TokenType =
  | 'NUMBER' | 'STRING' | 'FIELD_REF' | 'FUNC' | 'IDENT' | 'BOOL'
  | 'PLUS' | 'MINUS' | 'STAR' | 'SLASH' | 'PERCENT' | 'CARET' | 'AMP'
  | 'EQ' | 'NEQ' | 'LT' | 'GT' | 'LTE' | 'GTE'
  | 'LPAREN' | 'RPAREN' | 'COMMA'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string | number | boolean;
  pos: number;
}

// ─── AST node types ───────────────────────────────────────────────────────

type ASTNode =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'field_ref'; name: string }
  | { kind: 'func_call'; name: string; args: ASTNode[] }
  | { kind: 'unary'; op: string; operand: ASTNode }
  | { kind: 'binary'; op: string; left: ASTNode; right: ASTNode };

// ─── Tokenizer ────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Number literal
    if (/\d/.test(ch) || (ch === '.' && i + 1 < input.length && /\d/.test(input[i + 1]))) {
      let num = '';
      while (i < input.length && /[\d.]/.test(input[i])) { num += input[i++]; }
      tokens.push({ type: 'NUMBER', value: parseFloat(num), pos: i });
      continue;
    }

    // String literal (single or double quoted)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = '';
      i++; // skip opening quote
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) {
          i++;
          if (input[i] === 'n') str += '\n';
          else if (input[i] === 't') str += '\t';
          else str += input[i];
        } else {
          str += input[i];
        }
        i++;
      }
      i++; // skip closing quote
      tokens.push({ type: 'STRING', value: str, pos: i });
      continue;
    }

    // Field reference: {Field Name}
    if (ch === '{') {
      let name = '';
      i++; // skip {
      while (i < input.length && input[i] !== '}') { name += input[i++]; }
      i++; // skip }
      tokens.push({ type: 'FIELD_REF', value: name, pos: i });
      continue;
    }

    // Operators and punctuation
    if (ch === '+') { tokens.push({ type: 'PLUS', value: '+', pos: i++ }); continue; }
    if (ch === '-') { tokens.push({ type: 'MINUS', value: '-', pos: i++ }); continue; }
    if (ch === '*') { tokens.push({ type: 'STAR', value: '*', pos: i++ }); continue; }
    if (ch === '/') { tokens.push({ type: 'SLASH', value: '/', pos: i++ }); continue; }
    if (ch === '%') { tokens.push({ type: 'PERCENT', value: '%', pos: i++ }); continue; }
    if (ch === '^') { tokens.push({ type: 'CARET', value: '^', pos: i++ }); continue; }
    if (ch === '&') { tokens.push({ type: 'AMP', value: '&', pos: i++ }); continue; }
    if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(', pos: i++ }); continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')', pos: i++ }); continue; }
    if (ch === ',') { tokens.push({ type: 'COMMA', value: ',', pos: i++ }); continue; }

    // Two-character operators
    if (ch === '!' && input[i + 1] === '=') { tokens.push({ type: 'NEQ', value: '!=', pos: i }); i += 2; continue; }
    if (ch === '<' && input[i + 1] === '=') { tokens.push({ type: 'LTE', value: '<=', pos: i }); i += 2; continue; }
    if (ch === '>' && input[i + 1] === '>=') { tokens.push({ type: 'GTE', value: '>=', pos: i }); i += 2; continue; }
    if (ch === '<' && input[i + 1] === '>') { tokens.push({ type: 'NEQ', value: '!=', pos: i }); i += 2; continue; }
    if (ch === '<') { tokens.push({ type: 'LT', value: '<', pos: i++ }); continue; }
    if (ch === '>') {
      if (input[i + 1] === '=') { tokens.push({ type: 'GTE', value: '>=', pos: i }); i += 2; }
      else { tokens.push({ type: 'GT', value: '>', pos: i++ }); }
      continue;
    }
    if (ch === '=') { tokens.push({ type: 'EQ', value: '=', pos: i++ }); continue; }

    // Identifiers / function names / keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) { ident += input[i++]; }
      const upper = ident.toUpperCase();
      if (upper === 'TRUE') { tokens.push({ type: 'BOOL', value: true, pos: i }); continue; }
      if (upper === 'FALSE') { tokens.push({ type: 'BOOL', value: false, pos: i }); continue; }
      // Check if followed by ( → function call
      let j = i;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (j < input.length && input[j] === '(') {
        tokens.push({ type: 'FUNC', value: upper, pos: i });
      } else {
        tokens.push({ type: 'IDENT', value: ident, pos: i });
      }
      continue;
    }

    // Unknown character — skip
    i++;
  }

  tokens.push({ type: 'EOF', value: '', pos: i });
  return tokens;
}

// ─── Parser (recursive descent, precedence climbing) ──────────────────────

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token { return this.tokens[this.pos] || { type: 'EOF', value: '', pos: 0 }; }
  private advance(): Token { return this.tokens[this.pos++]; }
  private expect(type: TokenType): Token {
    const t = this.advance();
    if (t.type !== type) throw new Error(`Formula parse error: expected ${type}, got ${t.type} at pos ${t.pos}`);
    return t;
  }

  parse(): ASTNode {
    const node = this.parseExpr();
    if (this.peek().type !== 'EOF') {
      throw new Error(`Formula parse error: unexpected token ${this.peek().type} at pos ${this.peek().pos}`);
    }
    return node;
  }

  private parseExpr(): ASTNode {
    return this.parseOr();
  }

  private parseOr(): ASTNode {
    // Handle implicit OR via comparison chain
    return this.parseAnd();
  }

  private parseAnd(): ASTNode {
    return this.parseComparison();
  }

  private parseComparison(): ASTNode {
    let left = this.parseConcat();
    while (['EQ', 'NEQ', 'LT', 'GT', 'LTE', 'GTE'].includes(this.peek().type)) {
      const op = this.advance();
      const right = this.parseConcat();
      left = { kind: 'binary', op: String(op.value), left, right };
    }
    return left;
  }

  private parseConcat(): ASTNode {
    let left = this.parseAddSub();
    while (this.peek().type === 'AMP') {
      this.advance();
      const right = this.parseAddSub();
      left = { kind: 'binary', op: '&', left, right };
    }
    return left;
  }

  private parseAddSub(): ASTNode {
    let left = this.parseMulDiv();
    while (this.peek().type === 'PLUS' || this.peek().type === 'MINUS') {
      const op = this.advance();
      const right = this.parseMulDiv();
      left = { kind: 'binary', op: String(op.value), left, right };
    }
    return left;
  }

  private parseMulDiv(): ASTNode {
    let left = this.parsePower();
    while (this.peek().type === 'STAR' || this.peek().type === 'SLASH' || this.peek().type === 'PERCENT') {
      const op = this.advance();
      const right = this.parsePower();
      left = { kind: 'binary', op: String(op.value), left, right };
    }
    return left;
  }

  private parsePower(): ASTNode {
    let left = this.parseUnary();
    while (this.peek().type === 'CARET') {
      this.advance();
      const right = this.parseUnary();
      left = { kind: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parseUnary(): ASTNode {
    if (this.peek().type === 'MINUS') {
      this.advance();
      const operand = this.parseUnary();
      return { kind: 'unary', op: '-', operand };
    }
    if (this.peek().type === 'PLUS') {
      this.advance();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): ASTNode {
    const t = this.peek();

    // Number
    if (t.type === 'NUMBER') {
      this.advance();
      return { kind: 'number', value: t.value as number };
    }

    // String
    if (t.type === 'STRING') {
      this.advance();
      return { kind: 'string', value: t.value as string };
    }

    // Boolean
    if (t.type === 'BOOL') {
      this.advance();
      return { kind: 'boolean', value: t.value as boolean };
    }

    // Field reference
    if (t.type === 'FIELD_REF') {
      this.advance();
      return { kind: 'field_ref', name: t.value as string };
    }

    // Function call
    if (t.type === 'FUNC') {
      const name = this.advance().value as string;
      this.expect('LPAREN');
      const args: ASTNode[] = [];
      if (this.peek().type !== 'RPAREN') {
        args.push(this.parseExpr());
        while (this.peek().type === 'COMMA') {
          this.advance();
          args.push(this.parseExpr());
        }
      }
      this.expect('RPAREN');
      return { kind: 'func_call', name, args };
    }

    // Bare identifier — treat as field reference
    if (t.type === 'IDENT') {
      this.advance();
      return { kind: 'field_ref', name: t.value as string };
    }

    // Parenthesized expression
    if (t.type === 'LPAREN') {
      this.advance();
      const expr = this.parseExpr();
      this.expect('RPAREN');
      return expr;
    }

    throw new Error(`Formula parse error: unexpected ${t.type} "${t.value}" at pos ${t.pos}`);
  }
}

// ─── Evaluator ────────────────────────────────────────────────────────────

export interface FormulaContext {
  /** Field values by field name (or field ID). */
  fields: Record<string, any>;
  /** Record metadata for RECORD_ID(), CREATED_TIME(), etc. */
  recordId?: string;
  createdTime?: string;
  lastModifiedTime?: string;
}

function toNumber(v: any): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function toString(v: any): string {
  if (v == null) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function toBool(v: any): boolean {
  if (v == null || v === '' || v === 0 || v === false) return false;
  return true;
}

function isBlank(v: any): boolean {
  return v == null || v === '' || (typeof v === 'string' && v.trim() === '');
}

function toDate(v: any): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function evaluate(node: ASTNode, ctx: FormulaContext): any {
  switch (node.kind) {
    case 'number': return node.value;
    case 'string': return node.value;
    case 'boolean': return node.value;

    case 'field_ref': {
      const val = ctx.fields[node.name];
      return val === undefined ? null : val;
    }

    case 'unary': {
      const operand = evaluate(node.operand, ctx);
      if (node.op === '-') return -toNumber(operand);
      return operand;
    }

    case 'binary': {
      const left = evaluate(node.left, ctx);
      const right = evaluate(node.right, ctx);
      switch (node.op) {
        case '+': return toNumber(left) + toNumber(right);
        case '-': return toNumber(left) - toNumber(right);
        case '*': return toNumber(left) * toNumber(right);
        case '/': { const d = toNumber(right); return d === 0 ? '#ERROR!' : toNumber(left) / d; }
        case '%': { const d = toNumber(right); return d === 0 ? '#ERROR!' : toNumber(left) % d; }
        case '^': return Math.pow(toNumber(left), toNumber(right));
        case '&': return toString(left) + toString(right);
        case '=': return left === right || toString(left) === toString(right);
        case '!=': return left !== right && toString(left) !== toString(right);
        case '<': return toNumber(left) < toNumber(right);
        case '>': return toNumber(left) > toNumber(right);
        case '<=': return toNumber(left) <= toNumber(right);
        case '>=': return toNumber(left) >= toNumber(right);
        default: return '#ERROR!';
      }
    }

    case 'func_call':
      return evaluateFunction(node.name, node.args, ctx);
  }
}

// ─── Built-in functions ───────────────────────────────────────────────────

function evaluateFunction(name: string, argNodes: ASTNode[], ctx: FormulaContext): any {
  // Helper to evaluate args lazily
  const args = () => argNodes.map(a => evaluate(a, ctx));
  const arg = (i: number) => evaluate(argNodes[i], ctx);
  const argCount = argNodes.length;

  switch (name) {
    // ── Logical ──
    case 'IF': {
      const cond = toBool(arg(0));
      return cond ? arg(1) : (argCount > 2 ? arg(2) : '');
    }
    case 'AND': return args().every(toBool);
    case 'OR': return args().some(toBool);
    case 'NOT': return !toBool(arg(0));
    case 'XOR': {
      const vals = args().map(toBool);
      return vals.filter(Boolean).length % 2 === 1;
    }
    case 'TRUE': return true;
    case 'FALSE': return false;
    case 'BLANK': return null;
    case 'ERROR': return '#ERROR!';

    case 'SWITCH': {
      const expr = arg(0);
      for (let i = 1; i + 1 < argCount; i += 2) {
        if (toString(arg(i)) === toString(expr)) return arg(i + 1);
      }
      // Default value if odd number of remaining args
      if (argCount > 1 && (argCount - 1) % 2 === 1) return arg(argCount - 1);
      return '';
    }

    // ── Numeric ──
    case 'SUM': return args().reduce((s, v) => s + toNumber(v), 0);
    case 'AVERAGE': {
      const vals = args();
      return vals.length === 0 ? 0 : vals.reduce((s, v) => s + toNumber(v), 0) / vals.length;
    }
    case 'MIN': return Math.min(...args().map(toNumber));
    case 'MAX': return Math.max(...args().map(toNumber));
    case 'ABS': return Math.abs(toNumber(arg(0)));
    case 'SQRT': return Math.sqrt(toNumber(arg(0)));
    case 'POWER': return Math.pow(toNumber(arg(0)), toNumber(arg(1)));
    case 'LOG': return argCount > 1 ? Math.log(toNumber(arg(0))) / Math.log(toNumber(arg(1))) : Math.log10(toNumber(arg(0)));
    case 'EXP': return Math.exp(toNumber(arg(0)));
    case 'MOD': { const d = toNumber(arg(1)); return d === 0 ? '#ERROR!' : toNumber(arg(0)) % d; }
    case 'ROUND': return parseFloat(toNumber(arg(0)).toFixed(argCount > 1 ? toNumber(arg(1)) : 0));
    case 'ROUNDUP': {
      const n = toNumber(arg(0));
      const p = argCount > 1 ? toNumber(arg(1)) : 0;
      const m = Math.pow(10, p);
      return n >= 0 ? Math.ceil(n * m) / m : Math.floor(n * m) / m;
    }
    case 'ROUNDDOWN': {
      const n = toNumber(arg(0));
      const p = argCount > 1 ? toNumber(arg(1)) : 0;
      const m = Math.pow(10, p);
      return n >= 0 ? Math.floor(n * m) / m : Math.ceil(n * m) / m;
    }
    case 'FLOOR': return Math.floor(toNumber(arg(0)));
    case 'CEILING': return Math.ceil(toNumber(arg(0)));
    case 'INT': return Math.trunc(toNumber(arg(0)));
    case 'EVEN': { const n = Math.ceil(Math.abs(toNumber(arg(0)))); return (n % 2 === 0 ? n : n + 1) * Math.sign(toNumber(arg(0)) || 1); }
    case 'ODD': { const n = Math.ceil(Math.abs(toNumber(arg(0)))); return (n % 2 === 1 ? n : n + 1) * Math.sign(toNumber(arg(0)) || 1); }
    case 'VALUE': return toNumber(arg(0));

    // ── Text ──
    case 'CONCATENATE': return args().map(toString).join('');
    case 'LEFT': return toString(arg(0)).slice(0, toNumber(arg(1)));
    case 'RIGHT': { const s = toString(arg(0)); const n = toNumber(arg(1)); return s.slice(Math.max(0, s.length - n)); }
    case 'MID': return toString(arg(0)).slice(toNumber(arg(1)) - 1, toNumber(arg(1)) - 1 + toNumber(arg(2)));
    case 'LEN': return toString(arg(0)).length;
    case 'TRIM': return toString(arg(0)).trim();
    case 'LOWER': return toString(arg(0)).toLowerCase();
    case 'UPPER': return toString(arg(0)).toUpperCase();
    case 'PROPER': return toString(arg(0)).replace(/\b\w/g, c => c.toUpperCase());
    case 'REPT': return toString(arg(0)).repeat(Math.max(0, toNumber(arg(1))));
    case 'T': { const v = arg(0); return typeof v === 'string' ? v : ''; }
    case 'EXACT': return toString(arg(0)) === toString(arg(1));
    case 'FIND': {
      const needle = toString(arg(0));
      const haystack = toString(arg(1));
      const start = argCount > 2 ? toNumber(arg(2)) - 1 : 0;
      const idx = haystack.indexOf(needle, start);
      return idx === -1 ? 0 : idx + 1;
    }
    case 'SEARCH': {
      const needle = toString(arg(0)).toLowerCase();
      const haystack = toString(arg(1)).toLowerCase();
      const start = argCount > 2 ? toNumber(arg(2)) - 1 : 0;
      const idx = haystack.indexOf(needle, start);
      return idx === -1 ? 0 : idx + 1;
    }
    case 'SUBSTITUTE': {
      const s = toString(arg(0));
      const old = toString(arg(1));
      const rep = toString(arg(2));
      if (argCount > 3) {
        // Replace nth occurrence
        const n = toNumber(arg(3));
        let count = 0;
        return s.replace(new RegExp(old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), (match) => {
          count++;
          return count === n ? rep : match;
        });
      }
      return s.split(old).join(rep);
    }
    case 'REPLACE': {
      const s = toString(arg(0));
      const start = toNumber(arg(1)) - 1;
      const count = toNumber(arg(2));
      const rep = toString(arg(3));
      return s.slice(0, start) + rep + s.slice(start + count);
    }
    case 'ENCODE_URL_COMPONENT': return encodeURIComponent(toString(arg(0)));
    case 'REGEX_MATCH': {
      try {
        const s = toString(arg(0));
        const re = new RegExp(toString(arg(1)));
        const m = s.match(re);
        return m ? m[0] : null;
      } catch { return '#ERROR!'; }
    }
    case 'REGEX_EXTRACT': {
      try {
        const s = toString(arg(0));
        const re = new RegExp(toString(arg(1)));
        const m = s.match(re);
        return m && m[1] ? m[1] : (m ? m[0] : null);
      } catch { return '#ERROR!'; }
    }
    case 'REGEX_REPLACE': {
      try {
        const s = toString(arg(0));
        const re = new RegExp(toString(arg(1)), 'g');
        return s.replace(re, toString(arg(2)));
      } catch { return '#ERROR!'; }
    }

    // ── Date/Time ──
    case 'NOW': return new Date().toISOString();
    case 'TODAY': return new Date().toISOString().split('T')[0];
    case 'CREATED_TIME': return ctx.createdTime || null;
    case 'LAST_MODIFIED_TIME': return ctx.lastModifiedTime || null;

    case 'YEAR': { const d = toDate(arg(0)); return d ? d.getFullYear() : '#ERROR!'; }
    case 'MONTH': { const d = toDate(arg(0)); return d ? d.getMonth() + 1 : '#ERROR!'; }
    case 'DAY': { const d = toDate(arg(0)); return d ? d.getDate() : '#ERROR!'; }
    case 'HOUR': { const d = toDate(arg(0)); return d ? d.getHours() : '#ERROR!'; }
    case 'MINUTE': { const d = toDate(arg(0)); return d ? d.getMinutes() : '#ERROR!'; }
    case 'SECOND': { const d = toDate(arg(0)); return d ? d.getSeconds() : '#ERROR!'; }
    case 'WEEKDAY': { const d = toDate(arg(0)); return d ? d.getDay() : '#ERROR!'; }
    case 'WEEKNUM': {
      const d = toDate(arg(0));
      if (!d) return '#ERROR!';
      const start = new Date(d.getFullYear(), 0, 1);
      const diff = d.getTime() - start.getTime();
      return Math.ceil((diff / 86400000 + start.getDay() + 1) / 7);
    }

    case 'DATEADD': {
      const d = toDate(arg(0));
      if (!d) return '#ERROR!';
      const count = toNumber(arg(1));
      const unit = toString(arg(2)).toLowerCase();
      const result = new Date(d);
      switch (unit) {
        case 'years': case 'year': result.setFullYear(result.getFullYear() + count); break;
        case 'months': case 'month': result.setMonth(result.getMonth() + count); break;
        case 'weeks': case 'week': result.setDate(result.getDate() + count * 7); break;
        case 'days': case 'day': result.setDate(result.getDate() + count); break;
        case 'hours': case 'hour': result.setHours(result.getHours() + count); break;
        case 'minutes': case 'minute': result.setMinutes(result.getMinutes() + count); break;
        case 'seconds': case 'second': result.setSeconds(result.getSeconds() + count); break;
        default: return '#ERROR!';
      }
      return result.toISOString();
    }

    case 'DATETIME_DIFF': {
      const d1 = toDate(arg(0));
      const d2 = toDate(arg(1));
      if (!d1 || !d2) return '#ERROR!';
      const unit = argCount > 2 ? toString(arg(2)).toLowerCase() : 'seconds';
      const diffMs = d1.getTime() - d2.getTime();
      switch (unit) {
        case 'milliseconds': case 'ms': return diffMs;
        case 'seconds': case 's': return Math.floor(diffMs / 1000);
        case 'minutes': case 'm': return Math.floor(diffMs / 60000);
        case 'hours': case 'h': return Math.floor(diffMs / 3600000);
        case 'days': case 'd': return Math.floor(diffMs / 86400000);
        case 'weeks': case 'w': return Math.floor(diffMs / (86400000 * 7));
        case 'months': return (d1.getFullYear() - d2.getFullYear()) * 12 + (d1.getMonth() - d2.getMonth());
        case 'years': return d1.getFullYear() - d2.getFullYear();
        default: return Math.floor(diffMs / 1000);
      }
    }

    case 'DATETIME_FORMAT': {
      const d = toDate(arg(0));
      if (!d) return '#ERROR!';
      if (argCount < 2) return d.toISOString();
      // Simplified format string support
      let fmt = toString(arg(1));
      fmt = fmt.replace('YYYY', String(d.getFullYear()));
      fmt = fmt.replace('YY', String(d.getFullYear()).slice(-2));
      fmt = fmt.replace('MM', String(d.getMonth() + 1).padStart(2, '0'));
      fmt = fmt.replace('DD', String(d.getDate()).padStart(2, '0'));
      fmt = fmt.replace('HH', String(d.getHours()).padStart(2, '0'));
      fmt = fmt.replace('mm', String(d.getMinutes()).padStart(2, '0'));
      fmt = fmt.replace('ss', String(d.getSeconds()).padStart(2, '0'));
      return fmt;
    }

    case 'DATETIME_PARSE': {
      const d = toDate(arg(0));
      return d ? d.toISOString() : '#ERROR!';
    }

    case 'DATESTR': {
      const d = toDate(arg(0));
      return d ? d.toISOString().split('T')[0] : '#ERROR!';
    }

    case 'TIMESTR': {
      const d = toDate(arg(0));
      return d ? d.toISOString().split('T')[1].replace('Z', '') : '#ERROR!';
    }

    case 'IS_BEFORE': {
      const d1 = toDate(arg(0)); const d2 = toDate(arg(1));
      if (!d1 || !d2) return false;
      return d1.getTime() < d2.getTime();
    }
    case 'IS_AFTER': {
      const d1 = toDate(arg(0)); const d2 = toDate(arg(1));
      if (!d1 || !d2) return false;
      return d1.getTime() > d2.getTime();
    }
    case 'IS_SAME': {
      const d1 = toDate(arg(0)); const d2 = toDate(arg(1));
      if (!d1 || !d2) return false;
      const unit = argCount > 2 ? toString(arg(2)).toLowerCase() : 'day';
      switch (unit) {
        case 'year': return d1.getFullYear() === d2.getFullYear();
        case 'month': return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth();
        case 'day': return d1.toDateString() === d2.toDateString();
        case 'hour': return d1.toDateString() === d2.toDateString() && d1.getHours() === d2.getHours();
        case 'minute': return Math.abs(d1.getTime() - d2.getTime()) < 60000;
        default: return d1.toDateString() === d2.toDateString();
      }
    }

    case 'TONOW': {
      const d = toDate(arg(0));
      if (!d) return '#ERROR!';
      return Math.floor((Date.now() - d.getTime()) / 1000);
    }
    case 'FROMNOW': {
      const d = toDate(arg(0));
      if (!d) return '#ERROR!';
      return Math.floor((d.getTime() - Date.now()) / 1000);
    }

    case 'SET_TIMEZONE': {
      // Simplified — just return the date as-is (full timezone support would need Intl)
      return arg(0);
    }

    // ── Info / counting ──
    case 'RECORD_ID': return ctx.recordId || '';
    case 'COUNT': return args().filter(v => typeof v === 'number' && !Number.isNaN(v)).length;
    case 'COUNTA': return args().filter(v => !isBlank(v)).length;
    case 'COUNTALL': return argCount;
    case 'IF_ERROR': {
      const val = arg(0);
      return val === '#ERROR!' ? arg(1) : val;
    }
    case 'IS_ERROR': return arg(0) === '#ERROR!';

    // ── Array ──
    case 'ARRAYCOMPACT': {
      const v = arg(0);
      return Array.isArray(v) ? v.filter(x => !isBlank(x)) : v;
    }
    case 'ARRAYFLATTEN': {
      const v = arg(0);
      return Array.isArray(v) ? v.flat(Infinity) : v;
    }
    case 'ARRAYJOIN': {
      const v = arg(0);
      const sep = argCount > 1 ? toString(arg(1)) : ', ';
      return Array.isArray(v) ? v.join(sep) : toString(v);
    }
    case 'ARRAYSLICE': {
      const v = arg(0);
      if (!Array.isArray(v)) return v;
      const start = toNumber(arg(1));
      const end = argCount > 2 ? toNumber(arg(2)) : undefined;
      return v.slice(start, end);
    }
    case 'ARRAYUNIQUE': {
      const v = arg(0);
      return Array.isArray(v) ? [...new Set(v)] : v;
    }

    // ── Nested field access ──
    case 'FIELD': return ctx.fields[toString(arg(0))] ?? null;

    default:
      return '#ERROR!';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Parse and compile a formula string into a reusable AST. */
export function parseFormula(formula: string): ASTNode {
  const tokens = tokenize(formula);
  return new Parser(tokens).parse();
}

/** Evaluate a pre-parsed AST against a field context. */
export function evaluateAST(ast: ASTNode, ctx: FormulaContext): any {
  try {
    return evaluate(ast, ctx);
  } catch (e: any) {
    return '#ERROR!';
  }
}

/** One-shot: parse and evaluate a formula string. */
export function evaluateFormula(formula: string, ctx: FormulaContext): any {
  try {
    const ast = parseFormula(formula);
    return evaluateAST(ast, ctx);
  } catch (e: any) {
    return '#ERROR!';
  }
}

/**
 * Extract all field references from a formula string.
 * Useful for building dependency graphs.
 */
export function extractFieldReferences(formula: string): string[] {
  try {
    const ast = parseFormula(formula);
    const refs = new Set<string>();
    collectFieldRefs(ast, refs);
    return [...refs];
  } catch {
    return [];
  }
}

function collectFieldRefs(node: ASTNode, refs: Set<string>): void {
  switch (node.kind) {
    case 'field_ref':
      refs.add(node.name);
      break;
    case 'unary':
      collectFieldRefs(node.operand, refs);
      break;
    case 'binary':
      collectFieldRefs(node.left, refs);
      collectFieldRefs(node.right, refs);
      break;
    case 'func_call':
      for (const a of node.args) collectFieldRefs(a, refs);
      break;
  }
}
