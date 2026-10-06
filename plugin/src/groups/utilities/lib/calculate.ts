import { ToolError } from "../../../shared/errors";

/**
 * A small arithmetic evaluator: a tokenizer and a recursive-descent parser that computes as it goes.
 * The expression comes from a model, so nothing here hands text to the JavaScript engine to run.
 *
 * Precedence, loosest first: + -, then * / % (modulo) and "of", then unary + -, then ^ (right to
 * left), then the postfix ! and %. So -2^2 is -4 and 2^3^2 is 512.
 *
 * Percentages work as on a pocket calculator: "15%" is 0.15, "15% of 240" is 36, and adding or
 * subtracting a percentage takes it of the left side, so "200 + 15%" is 230.
 */

export const MAX_EXPRESSION_LENGTH = 1000;
export const MAX_DEPTH = 100;

const SUPPORTED =
  'Supported: numbers (1e6, .5, 1_000), + - * / % ^ ** ( ), n!, percentages ("15% of 240", "200 + 15%"), ' +
  "the constants pi, e, tau, and the functions sqrt cbrt abs round floor ceil trunc sign min max sum avg mod " +
  "ln log log10 log2 exp sin cos tan asin acos atan atan2 pow hypot.";

type TokenType = "number" | "name" | "op" | "end";

interface Token {
  type: TokenType;
  text: string;
  value: number;
  /** 1-based, as a person would count it. */
  position: number;
}

/** A value, and whether it was written as a percentage ("15%"), which changes what + and - do with it. */
interface Operand {
  value: number;
  percent: boolean;
}

const NUMBER = /^(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPERATORS = ["**", "+", "-", "*", "/", "%", "^", "(", ")", ",", "!"];
/** Signs people paste from documents. */
const LOOKALIKES: Record<string, string> = { "×": "*", "·": "*", "÷": "/", "−": "-", "–": "-", "π": "pi", "τ": "tau" };

function syntaxError(message: string, position: number): ToolError {
  return new ToolError(`Syntax error at position ${position}: ${message} ${SUPPORTED}`);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    const position = index + 1;
    const rest = source.slice(index);
    const lookalike = LOOKALIKES[char];
    if (lookalike) {
      tokens.push({ type: /[a-z]/.test(lookalike) ? "name" : "op", text: lookalike, value: 0, position });
      index++;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      const value = Number(number[0].replace(/_/g, ""));
      if (!Number.isFinite(value)) throw new ToolError(`Overflow: ${number[0]} at position ${position} is too large to represent.`);
      tokens.push({ type: "number", text: number[0], value, position });
      index += number[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ type: "name", text: name[0].toLowerCase(), value: 0, position });
      index += name[0].length;
      continue;
    }
    const operator = OPERATORS.find(op => rest.startsWith(op));
    if (operator) {
      tokens.push({ type: "op", text: operator, value: 0, position });
      index += operator.length;
      continue;
    }
    throw syntaxError(`unexpected "${char}".`, position);
  }
  tokens.push({ type: "end", text: "", value: 0, position: source.length + 1 });
  return tokens;
}

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };

interface FunctionSpec {
  min: number;
  max: number;
  apply: (args: number[]) => number;
}

function domain(message: string): never {
  throw new ToolError(`Domain error: ${message}`);
}

function positive(name: string, x: number): number {
  if (x <= 0) domain(`${name}(${formatNumber(x)}) is undefined; ${name} needs a number above 0.`);
  return x;
}

/** Rounds half away from zero, as people do by hand, and without 1.005 becoming 1. */
function roundTo(x: number, digits: number): number {
  if (!Number.isInteger(digits) || Math.abs(digits) > 15) domain("round(x, digits) needs a whole number of digits from -15 to 15.");
  if (digits >= 0 && Number.isInteger(x)) return x;
  const magnitude = Math.abs(x);
  // Shifting the decimal point in the text, not by multiplying, is what keeps 1.005 from being 1.00499….
  const text = String(magnitude);
  const shifted = text.includes("e") ? "e" : String(Math.round(Number(`${text}e${digits}`)));
  const rounded = shifted.includes("e") ? Math.round(magnitude * 10 ** digits) / 10 ** digits : Number(`${shifted}e${-digits}`);
  return Math.sign(x) * rounded;
}

function divide(a: number, b: number): number {
  if (b === 0) throw new ToolError("Division by zero.");
  return a / b;
}

function modulo(a: number, b: number): number {
  if (b === 0) throw new ToolError("Division by zero (modulo 0).");
  return a % b;
}

function power(base: number, exponent: number): number {
  if (base === 0 && exponent < 0) throw new ToolError("Division by zero (0 to a negative power).");
  if (base < 0 && !Number.isInteger(exponent)) {
    domain(`${formatNumber(base)} ^ ${formatNumber(exponent)} is not a real number (a negative base needs a whole exponent).`);
  }
  return base ** exponent;
}

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) domain(`${formatNumber(n)}! is undefined; factorial needs a whole number from 0 to 170.`);
  if (n > 170) throw new ToolError(`Overflow: ${formatNumber(n)}! is too large to represent (170! is the largest).`);
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

const unary = (apply: (x: number) => number): FunctionSpec => ({ min: 1, max: 1, apply: ([x]) => apply(x) });
const unitRange = (name: string, x: number) =>
  x < -1 || x > 1 ? domain(`${name}(${formatNumber(x)}) is undefined; ${name} needs a number from -1 to 1.`) : x;

const FUNCTIONS: Record<string, FunctionSpec> = {
  sqrt: unary(x => (x < 0 ? domain(`sqrt(${formatNumber(x)}) is not a real number.`) : Math.sqrt(x))),
  cbrt: unary(Math.cbrt),
  abs: unary(Math.abs),
  floor: unary(Math.floor),
  ceil: unary(Math.ceil),
  trunc: unary(Math.trunc),
  sign: unary(Math.sign),
  exp: unary(Math.exp),
  ln: unary(x => Math.log(positive("ln", x))),
  log10: unary(x => Math.log10(positive("log10", x))),
  log2: unary(x => Math.log2(positive("log2", x))),
  // log(x) is base 10, as on a calculator; log(x, base) takes any base.
  log: {
    min: 1,
    max: 2,
    apply: ([x, base]) => {
      positive("log", x);
      if (base === undefined) return Math.log10(x);
      if (base <= 0 || base === 1) domain("log(x, base) needs a base above 0 that is not 1.");
      return Math.log(x) / Math.log(base);
    },
  },
  sin: unary(Math.sin),
  cos: unary(Math.cos),
  tan: unary(Math.tan),
  asin: unary(x => Math.asin(unitRange("asin", x))),
  acos: unary(x => Math.acos(unitRange("acos", x))),
  atan: unary(Math.atan),
  atan2: { min: 2, max: 2, apply: ([y, x]) => Math.atan2(y, x) },
  pow: { min: 2, max: 2, apply: ([base, exponent]) => power(base, exponent) },
  mod: { min: 2, max: 2, apply: ([a, b]) => modulo(a, b) },
  round: { min: 1, max: 2, apply: ([x, digits]) => roundTo(x, digits ?? 0) },
  hypot: { min: 1, max: Infinity, apply: args => Math.hypot(...args) },
  min: { min: 1, max: Infinity, apply: args => Math.min(...args) },
  max: { min: 1, max: Infinity, apply: args => Math.max(...args) },
  sum: { min: 1, max: Infinity, apply: args => args.reduce((total, x) => total + x, 0) },
  avg: { min: 1, max: Infinity, apply: args => args.reduce((total, x) => total + x, 0) / args.length },
};

const TRIGONOMETRY = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "atan2"]);

class Parser {
  private index = 0;
  /** Things worth telling the model about how its expression was read. */
  readonly notes = new Set<string>();

  constructor(private readonly tokens: Token[]) {}

  private get current(): Token {
    return this.tokens[this.index];
  }

  private isOp(text: string, token = this.current): boolean {
    return token.type === "op" && token.text === text;
  }

  private describe(token: Token): string {
    return token.type === "end" ? "the end of the expression" : `"${token.text}"`;
  }

  /** Every result passes through here, so no NaN or Infinity travels on to give a nonsense answer. */
  private check(value: number, what: string): number {
    if (Number.isNaN(value)) domain(`${what} is not a real number.`);
    if (!Number.isFinite(value)) throw new ToolError(`Overflow: ${what} is too large to represent.`);
    return value;
  }

  parse(): number {
    const result = this.additive(0);
    const token = this.current;
    if (this.isOp(",")) {
      throw syntaxError(
        'unexpected ",". A comma only separates the arguments of a function, so write 1000 or 1_000 rather than 1,000.',
        token.position,
      );
    }
    if (token.type !== "end") {
      const hint = token.type === "op" ? "" : " There is no implicit multiplication: write 2 * x, not 2 x.";
      throw syntaxError(`unexpected ${this.describe(token)}.${hint}`, token.position);
    }
    return result.value;
  }

  private additive(depth: number): Operand {
    let left = this.multiplicative(depth);
    while (this.isOp("+") || this.isOp("-")) {
      const sign = this.current.text === "+" ? 1 : -1;
      this.index++;
      const right = this.multiplicative(depth);
      // "200 + 15%" means 15% of the 200. Two percentages just add up: "10% + 5%" is 15%.
      const amount = right.percent && !left.percent ? left.value * right.value : right.value;
      // "10 % -3" could have meant a remainder; say how it was read rather than guess silently.
      if (left.percent && !right.percent) this.notes.add("% was read as a percentage; for a remainder write mod(a, b)");
      left = { value: this.check(left.value + sign * amount, "the sum"), percent: left.percent && right.percent };
    }
    return left;
  }

  private multiplicative(depth: number): Operand {
    let left = this.unary(depth);
    while (true) {
      const token = this.current;
      if (this.isOp("*")) {
        this.index++;
        left = { value: this.check(left.value * this.unary(depth).value, "the product"), percent: false };
      } else if (this.isOp("/")) {
        this.index++;
        left = { value: this.check(divide(left.value, this.unary(depth).value), "the quotient"), percent: false };
      } else if (this.isOp("%")) {
        // A % that was a percentage has been taken by postfix(); one that is still here is modulo.
        this.index++;
        left = { value: this.check(modulo(left.value, this.unary(depth).value), "the remainder"), percent: false };
      } else if (token.type === "name" && token.text === "of") {
        if (!left.percent) throw syntaxError('"of" only follows a percentage, as in "15% of 240".', token.position);
        this.index++;
        const right = this.unary(depth);
        left = { value: this.check(left.value * right.value, "the product"), percent: right.percent };
      } else {
        return left;
      }
    }
  }

  private unary(depth: number): Operand {
    let sign = 1;
    while (this.isOp("+") || this.isOp("-")) {
      if (this.current.text === "-") sign = -sign;
      this.index++;
    }
    const operand = this.power(depth);
    return sign === 1 ? operand : { value: -operand.value, percent: operand.percent };
  }

  private power(depth: number): Operand {
    const base = this.postfix(depth);
    if (!this.isOp("^") && !this.isOp("**")) return base;
    this.index++;
    // The exponent is parsed one level up, which makes ^ right-associative and allows 2^-3.
    const exponent = this.unary(depth + 1);
    return { value: this.check(power(base.value, exponent.value), "the power"), percent: false };
  }

  private postfix(depth: number): Operand {
    let operand = this.primary(depth);
    while (true) {
      if (this.isOp("!")) {
        this.index++;
        operand = { value: factorial(operand.value), percent: false };
      } else if (this.isOp("%") && !this.startsOperand(this.tokens[this.index + 1])) {
        this.index++;
        operand = { value: operand.value / 100, percent: true };
      } else {
        return operand;
      }
    }
  }

  /** Whether a % is followed by something to take the remainder with; if not, it is a percent sign. */
  private startsOperand(token: Token): boolean {
    if (token.type === "number") return true;
    if (token.type === "name") return token.text !== "of";
    return this.isOp("(", token);
  }

  private primary(depth: number): Operand {
    if (depth > MAX_DEPTH) {
      throw new ToolError(`The expression is nested more than ${MAX_DEPTH} levels deep. Split it into smaller calculations.`);
    }
    const token = this.current;
    if (token.type === "number") {
      this.index++;
      return { value: token.value, percent: false };
    }
    if (this.isOp("(")) {
      this.index++;
      const inner = this.additive(depth + 1);
      this.expectClosing(token);
      return inner;
    }
    if (token.type === "name") {
      this.index++;
      if (this.isOp("(")) return { value: this.call(token, depth), percent: false };
      if (Object.hasOwn(CONSTANTS, token.text)) return { value: CONSTANTS[token.text], percent: false };
      if (Object.hasOwn(FUNCTIONS, token.text)) throw syntaxError(`${token.text} is a function and needs arguments, as in ${token.text}(2).`, token.position);
      throw this.unknown(token);
    }
    throw syntaxError(`expected a number, a name or "(" but found ${this.describe(token)}.`, token.position);
  }

  private unknown(token: Token): ToolError {
    return new ToolError(`Unknown name "${token.text}" at position ${token.position}. ${SUPPORTED}`);
  }

  private expectClosing(opening: Token): void {
    if (!this.isOp(")")) {
      const found = this.current;
      throw syntaxError(`expected ")" to close the "(" at position ${opening.position} but found ${this.describe(found)}.`, found.position);
    }
    this.index++;
  }

  private call(name: Token, depth: number): number {
    const spec = Object.hasOwn(FUNCTIONS, name.text) ? FUNCTIONS[name.text] : undefined;
    if (!spec) throw this.unknown(name);
    const opening = this.current;
    this.index++;
    const args: number[] = [];
    if (!this.isOp(")")) {
      while (true) {
        args.push(this.additive(depth + 1).value);
        if (!this.isOp(",")) break;
        this.index++;
      }
    }
    this.expectClosing(opening);
    if (args.length < spec.min || args.length > spec.max) {
      const wanted =
        spec.max === Infinity ? `at least ${spec.min}` : spec.min === spec.max ? String(spec.min) : `${spec.min} or ${spec.max}`;
      throw new ToolError(`${name.text}() at position ${name.position} takes ${wanted} argument${wanted === "1" ? "" : "s"}, not ${args.length}.`);
    }
    if (TRIGONOMETRY.has(name.text)) this.notes.add("angles are in radians");
    if (name.text === "log" && args.length === 1) this.notes.add("log is base 10; ln is the natural logarithm");
    return this.check(spec.apply(args), `${name.text}(${args.map(formatNumber).join(", ")})`);
  }
}

/**
 * A number as a person would write it: binary floating-point noise is rounded away (0.1 + 0.2 is
 * 0.3), whole numbers are exact while a double can hold them exactly, and anything larger is in
 * exponent form rather than a long row of digits that are not all real.
 */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return String(value === 0 ? 0 : value);
  const rounded = Number(value.toPrecision(14));
  if (rounded === 0) return "0";
  if (Math.abs(rounded) > Number.MAX_SAFE_INTEGER) return rounded.toExponential();
  return String(rounded);
}

export interface Calculation {
  /** The expression as it was evaluated: trimmed, without a trailing "=". */
  expression: string;
  value: number;
  /** The value, formatted for reading. */
  result: string;
  notes: string[];
}

/** Evaluates an arithmetic expression. Throws ToolError for anything the model can fix. */
export function evaluate(input: string): Calculation {
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new ToolError(`The expression is ${input.length} characters long; the limit is ${MAX_EXPRESSION_LENGTH}. Split it into smaller calculations.`);
  }
  // Models often end with "=", as if writing on paper.
  const expression = input.trim().replace(/\s*=\s*\??$/, "");
  if (!expression) throw new ToolError(`The expression is empty. ${SUPPORTED}`);
  const parser = new Parser(tokenize(expression));
  const value = parser.parse();
  return { expression, value, result: formatNumber(value), notes: [...parser.notes] };
}

/** "expression = result", the way the calculate tool answers. */
export function calculate(input: string): string {
  const { expression, result, notes } = evaluate(input);
  return `${expression} = ${result}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}
