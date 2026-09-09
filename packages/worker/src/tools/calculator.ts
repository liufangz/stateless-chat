import { TOOL_MANIFESTS, manifestToJsonSchema } from "@stateless-chat/shared";
import type { Tool } from "../tool-loop.js";

const MANIFEST = TOOL_MANIFESTS.find((m) => m.name === "calculator")!;

export const calculatorTool: Tool = {
  name: MANIFEST.name,
  description: MANIFEST.description,
  readOnly: MANIFEST.readOnly,
  parameters: manifestToJsonSchema(MANIFEST),
  execute(args: unknown): string {
    const { expression } = (args ?? {}) as { expression?: unknown };
    if (typeof expression !== "string" || expression.trim() === "") {
      throw new Error("calculator requires a non-empty 'expression' string");
    }
    return String(evaluateExpression(expression));
  },
};

// --- Calculator: self-contained recursive-descent parser --------------
// Never eval()/new Function() on model-supplied strings — args are LLM
// output and could carry a prompt-injection payload.

type TokenType =
  | "number"
  | "plus"
  | "minus"
  | "star"
  | "slash"
  | "caret"
  | "lparen"
  | "rparen"
  | "ident"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
}

function tokenizeExpression(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i])) i++;
      tokens.push({ type: "number", value: input.slice(start, i) });
      continue;
    }
    if (/[a-zA-Z]/.test(c)) {
      const start = i;
      while (i < input.length && /[a-zA-Z]/.test(input[i])) i++;
      tokens.push({ type: "ident", value: input.slice(start, i) });
      continue;
    }
    const single: Partial<Record<string, TokenType>> = {
      "+": "plus",
      "-": "minus",
      "*": "star",
      "/": "slash",
      "^": "caret",
      "(": "lparen",
      ")": "rparen",
    };
    const type = single[c];
    if (!type) {
      throw new Error(`Unexpected character '${c}' in expression`);
    }
    tokens.push({ type, value: c });
    i++;
  }
  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class ExpressionParser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const t = this.advance();
    if (t.type !== type) {
      throw new Error(`Expected '${type}' but got '${t.value || t.type}'`);
    }
    return t;
  }

  parse(): number {
    const value = this.parseExpression();
    this.expect("eof");
    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (this.peek().type === "plus" || this.peek().type === "minus") {
      const op = this.advance();
      const rhs = this.parseTerm();
      value = op.type === "plus" ? value + rhs : value - rhs;
    }
    return value;
  }

  private parseTerm(): number {
    let value = this.parsePower();
    while (this.peek().type === "star" || this.peek().type === "slash") {
      const op = this.advance();
      const rhs = this.parsePower();
      if (op.type === "slash") {
        if (rhs === 0) throw new Error("Division by zero");
        value = value / rhs;
      } else {
        value = value * rhs;
      }
    }
    return value;
  }

  private parsePower(): number {
    const base = this.parseUnary();
    if (this.peek().type === "caret") {
      this.advance();
      return Math.pow(base, this.parsePower()); // right-associative
    }
    return base;
  }

  private parseUnary(): number {
    if (this.peek().type === "plus") {
      this.advance();
      return this.parseUnary();
    }
    if (this.peek().type === "minus") {
      this.advance();
      return -this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const t = this.peek();
    if (t.type === "number") {
      this.advance();
      const n = Number(t.value);
      if (Number.isNaN(n)) throw new Error(`Invalid number '${t.value}'`);
      return n;
    }
    if (t.type === "lparen") {
      this.advance();
      const value = this.parseExpression();
      this.expect("rparen");
      return value;
    }
    if (t.type === "ident") {
      this.advance();
      const name = t.value.toLowerCase();
      if (name === "sqrt") {
        this.expect("lparen");
        const arg = this.parseExpression();
        this.expect("rparen");
        if (arg < 0) throw new Error("Cannot take sqrt of a negative number");
        return Math.sqrt(arg);
      }
      throw new Error(`Unknown function '${t.value}'`);
    }
    throw new Error(`Unexpected token '${t.value || t.type}'`);
  }
}

export function evaluateExpression(expression: string): number {
  const tokens = tokenizeExpression(expression);
  return new ExpressionParser(tokens).parse();
}
