/**
 * Recursive descent parser for formula syntax.
 * Produces an AST from the token stream.
 *
 * Operator precedence (lowest to highest):
 * 1. =, !=            (equality)
 * 2. <, <=, >, >=     (comparison)
 * 3. &                (concatenation)
 * 4. +, -             (addition/subtraction)
 * 5. *, /             (multiplication/division)
 * 6. unary -, NOT()
 * 7. (), {FieldRef}, function calls
 */

import type { Token, ASTNode } from './types';
import { tokenize } from './tokenizer';

class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private expect(type: string, value?: string): Token {
    const token = this.peek();
    if (token.type !== type || (value !== undefined && token.value !== value)) {
      throw new Error(
        `Formula parse error at position ${token.position}: expected ${type}${value ? ` '${value}'` : ''}, got ${token.type} '${token.value}'`
      );
    }
    return this.advance();
  }

  parse(): ASTNode {
    const node = this.parseExpression();
    if (this.peek().type !== 'EOF') {
      throw new Error(`Unexpected token '${this.peek().value}' at position ${this.peek().position}`);
    }
    return node;
  }

  // Precedence Level 1: Equality
  private parseExpression(): ASTNode {
    let left = this.parseComparison();
    while (this.peek().type === 'OPERATOR' && (this.peek().value === '=' || this.peek().value === '!=')) {
      const op = this.advance().value;
      const right = this.parseComparison();
      left = { type: 'BinaryExpr', operator: op, left, right };
    }
    return left;
  }

  // Precedence Level 2: Comparison
  private parseComparison(): ASTNode {
    let left = this.parseConcatenation();
    while (this.peek().type === 'OPERATOR' &&
      (this.peek().value === '<' || this.peek().value === '<=' ||
        this.peek().value === '>' || this.peek().value === '>=')) {
      const op = this.advance().value;
      const right = this.parseConcatenation();
      left = { type: 'BinaryExpr', operator: op, left, right };
    }
    return left;
  }

  // Precedence Level 3: Concatenation
  private parseConcatenation(): ASTNode {
    let left = this.parseAddition();
    while (this.peek().type === 'OPERATOR' && this.peek().value === '&') {
      this.advance();
      const right = this.parseAddition();
      left = { type: 'BinaryExpr', operator: '&', left, right };
    }
    return left;
  }

  // Precedence Level 4: Addition/Subtraction
  private parseAddition(): ASTNode {
    let left = this.parseMultiplication();
    while (this.peek().type === 'OPERATOR' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.advance().value;
      const right = this.parseMultiplication();
      left = { type: 'BinaryExpr', operator: op, left, right };
    }
    return left;
  }

  // Precedence Level 5: Multiplication/Division
  private parseMultiplication(): ASTNode {
    let left = this.parseUnary();
    while (this.peek().type === 'OPERATOR' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.advance().value;
      const right = this.parseUnary();
      left = { type: 'BinaryExpr', operator: op, left, right };
    }
    return left;
  }

  // Precedence Level 6: Unary
  private parseUnary(): ASTNode {
    if (this.peek().type === 'OPERATOR' && this.peek().value === '-') {
      this.advance();
      const operand = this.parseUnary();
      return { type: 'UnaryExpr', operator: '-', operand };
    }
    return this.parsePrimary();
  }

  // Precedence Level 7: Primary
  private parsePrimary(): ASTNode {
    const token = this.peek();

    if (token.type === 'NUMBER') {
      this.advance();
      return { type: 'NumberLiteral', value: parseFloat(token.value) };
    }

    if (token.type === 'STRING') {
      this.advance();
      return { type: 'StringLiteral', value: token.value };
    }

    if (token.type === 'NEWLINE') {
      this.advance();
      return { type: 'StringLiteral', value: '\n' };
    }

    if (token.type === 'FIELD_REF') {
      this.advance();
      return { type: 'FieldRef', fieldName: token.value };
    }

    if (token.type === 'LPAREN') {
      this.advance();
      const expr = this.parseExpression();
      this.expect('RPAREN');
      return expr;
    }

    if (token.type === 'FUNCTION') {
      const name = this.advance().value;

      if (this.peek().type === 'LPAREN') {
        this.advance();
        const args: ASTNode[] = [];

        if (this.peek().type !== 'RPAREN') {
          args.push(this.parseExpression());
          while (this.peek().type === 'COMMA') {
            this.advance();
            args.push(this.parseExpression());
          }
        }

        this.expect('RPAREN');
        return { type: 'FunctionCall', name, args };
      }

      // Bare keyword without parens — treat as zero-arg function
      return { type: 'FunctionCall', name, args: [] };
    }

    throw new Error(
      `Formula parse error at position ${token.position}: unexpected token '${token.value}'`
    );
  }
}

export function parseFormula(formula: string): ASTNode {
  const tokens = tokenize(formula);
  const parser = new Parser(tokens);
  return parser.parse();
}

export function extractFieldRefs(formula: string): string[] {
  const refs: string[] = [];
  const tokens = tokenize(formula);
  for (const token of tokens) {
    if (token.type === 'FIELD_REF') {
      refs.push(token.value);
    }
  }
  return [...new Set(refs)];
}
