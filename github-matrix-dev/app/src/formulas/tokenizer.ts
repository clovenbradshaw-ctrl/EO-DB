/**
 * Converts a formula string into a token stream.
 */

import type { Token } from './types';

const OPERATORS = new Set(['+', '-', '*', '/', '&', '=', '!=', '<', '>', '<=', '>=']);

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;

  while (pos < input.length) {
    const ch = input[pos];

    // Skip whitespace (except newlines which are meaningful)
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      pos++;
      continue;
    }

    // Newline literal: '\n' (as a 4-char sequence in the formula text)
    if (ch === "'" && input.slice(pos, pos + 4) === "'\\n'") {
      tokens.push({ type: 'NEWLINE', value: '\n', position: pos });
      pos += 4;
      continue;
    }

    // Numbers: 123, 3.14, .5
    if (ch >= '0' && ch <= '9' || (ch === '.' && pos + 1 < input.length && input[pos + 1] >= '0' && input[pos + 1] <= '9')) {
      let num = '';
      const start = pos;
      while (pos < input.length && (input[pos] >= '0' && input[pos] <= '9' || input[pos] === '.')) {
        num += input[pos];
        pos++;
      }
      tokens.push({ type: 'NUMBER', value: num, position: start });
      continue;
    }

    // String literals: "hello"
    if (ch === '"') {
      let str = '';
      const start = pos;
      pos++;
      while (pos < input.length && input[pos] !== '"') {
        if (input[pos] === '\\' && pos + 1 < input.length) {
          const next = input[pos + 1];
          if (next === '"') { str += '"'; pos += 2; continue; }
          if (next === '\\') { str += '\\'; pos += 2; continue; }
          if (next === 'n') { str += '\n'; pos += 2; continue; }
        }
        str += input[pos];
        pos++;
      }
      if (pos < input.length) pos++;
      tokens.push({ type: 'STRING', value: str, position: start });
      continue;
    }

    // Field references: {Field Name}
    if (ch === '{') {
      let name = '';
      const start = pos;
      pos++;
      while (pos < input.length && input[pos] !== '}') {
        name += input[pos];
        pos++;
      }
      if (pos < input.length) pos++;
      tokens.push({ type: 'FIELD_REF', value: name, position: start });
      continue;
    }

    // Two-character operators: !=, <=, >=
    if (pos + 1 < input.length) {
      const two = ch + input[pos + 1];
      if (two === '!=' || two === '<=' || two === '>=') {
        tokens.push({ type: 'OPERATOR', value: two, position: pos });
        pos += 2;
        continue;
      }
    }

    // Single-character operators
    if (OPERATORS.has(ch)) {
      tokens.push({ type: 'OPERATOR', value: ch, position: pos });
      pos++;
      continue;
    }

    // Parentheses
    if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(', position: pos }); pos++; continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')', position: pos }); pos++; continue; }

    // Comma
    if (ch === ',') { tokens.push({ type: 'COMMA', value: ',', position: pos }); pos++; continue; }

    // Function names and keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let name = '';
      const start = pos;
      while (pos < input.length && ((input[pos] >= 'a' && input[pos] <= 'z') ||
        (input[pos] >= 'A' && input[pos] <= 'Z') ||
        (input[pos] >= '0' && input[pos] <= '9') ||
        input[pos] === '_')) {
        name += input[pos];
        pos++;
      }
      tokens.push({ type: 'FUNCTION', value: name.toUpperCase(), position: start });
      continue;
    }

    // Unknown character — skip with warning
    console.warn(`Formula tokenizer: unexpected character '${ch}' at position ${pos}`);
    pos++;
  }

  tokens.push({ type: 'EOF', value: '', position: pos });
  return tokens;
}
