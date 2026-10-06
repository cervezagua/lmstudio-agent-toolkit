import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { ToolError } from "../../shared/errors";
import { callTool } from "../../shared/testing/fake-controller";
import { calculate, evaluate, formatNumber, MAX_DEPTH, MAX_EXPRESSION_LENGTH } from "./lib/calculate";
import { formatCurrentTime, systemTimeZone, zonedTime } from "./lib/currentTime";
import { makeUtilityTools, toolsProvider } from "./toolsProvider";

describe("calculate", () => {
  it.each([
    // precedence and associativity
    ["1 + 2 * 3", "7"],
    ["(1 + 2) * 3", "9"],
    ["10 - 4 - 3", "3"],
    ["100 / 10 / 5", "2"],
    ["10 / 4", "2.5"],
    ["2 ^ 3 ^ 2", "512"],
    ["2 ** 3 ** 2", "512"],
    ["2 * 3 ^ 2", "18"],
    // unary signs
    ["-2^2", "-4"],
    ["(-2)^2", "4"],
    ["2^-2", "0.25"],
    ["--2", "2"],
    ["2 - -3", "5"],
    ["+5", "5"],
    ["2 * -3", "-6"],
    ["-(3 + 4)", "-7"],
    // modulo
    ["10 % 3", "1"],
    ["7 % 2 * 3", "3"],
    ["-7 % 3", "-1"],
    ["10 % (3 + 1)", "2"],
    ["mod(10, -3)", "1"],
    // number forms
    ["1e6", "1000000"],
    ["1.5e3", "1500"],
    ["2E-3", "0.002"],
    [".5 + .25", "0.75"],
    ["1_000 * 3", "3000"],
    ["1_000_000 / 4", "250000"],
    ["5. + 1", "6"],
    // float noise
    ["0.1 + 0.2", "0.3"],
    ["1.1 * 3", "3.3"],
    ["0.1 * 3", "0.3"],
    ["1 - 0.9", "0.1"],
    ["4.35 * 100", "435"],
    ["sum(0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1)", "1"],
    ["1 / 3", "0.33333333333333"],
    ["2 / 3", "0.66666666666667"],
    ["2 ^ 0.5", "1.4142135623731"],
    // percentages
    ["15%", "0.15"],
    ["15% of 240", "36"],
    ["7.5% of 1200", "90"],
    ["200 + 15%", "230"],
    ["200 - 15%", "170"],
    ["200 * 15%", "30"],
    ["100 / 50%", "200"],
    ["10% + 5%", "0.15"],
    ["100 + 10% + 10%", "121"],
    ["15% of 240 + 10", "46"],
    ["50% of 10% of 200", "10"],
    ["(10 + 5)% of 200", "30"],
    ["15 % of 240", "36"],
    // constants, in any case
    ["pi", "3.1415926535898"],
    ["PI", "3.1415926535898"],
    ["tau / 2", "3.1415926535898"],
    ["e", "2.718281828459"],
    ["2 * Pi * 10", "62.831853071796"],
    // functions
    ["sqrt(16)", "4"],
    ["SQRT(2) ^ 2", "2"],
    ["cbrt(27)", "3"],
    ["abs(-3.5)", "3.5"],
    ["round(2.5)", "3"],
    ["round(-2.5)", "-3"],
    ["round(2.4)", "2"],
    ["round(1.005, 2)", "1.01"],
    ["round(pi, 4)", "3.1416"],
    ["round(1234.5, -2)", "1200"],
    ["round(12345678901234567890, 2)", "1.2345678901235e+19"],
    ["floor(-1.5)", "-2"],
    ["ceil(1.2)", "2"],
    ["trunc(-1.7)", "-1"],
    ["sign(-9)", "-1"],
    ["min(3, 1, 2)", "1"],
    ["max(3, 1, 2)", "3"],
    ["max(1,000)", "1"],
    ["sum(1, 2, 3)", "6"],
    ["avg(1, 2, 3, 4)", "2.5"],
    ["ln(e)", "1"],
    ["ln(e ^ 3)", "3"],
    ["log(8, 2)", "3"],
    ["log10(0.001)", "-3"],
    ["log2(1024)", "10"],
    ["exp(0)", "1"],
    ["pow(2, 10)", "1024"],
    ["hypot(3, 4)", "5"],
    ["sqrt(abs(min(-16, 4)))", "4"],
    // factorial
    ["5!", "120"],
    ["0!", "1"],
    ["3!!", "720"],
    ["2^3!", "64"],
    ["-3!", "-6"],
    ["18!", "6402373705728000"],
    ["20!", "2.4329020081766e+18"],
    ["170!", "7.257415615308e+306"],
    // big and small numbers
    ["123456789 * 1000", "123456789000"],
    ["2^53 - 1", "9007199254740991"],
    ["2^53", "9.007199254741e+15"],
    ["1e21", "1e+21"],
    ["10^100", "1e+100"],
    ["1 / 1e10", "1e-10"],
    ["0 * -1", "0"],
  ])("%s = %s", (expression, result) => {
    expect(calculate(expression)).toBe(`${expression} = ${result}`);
  });

  it("says how an ambiguous expression was read", () => {
    expect(calculate("log(1000)")).toBe("log(1000) = 3 (log is base 10; ln is the natural logarithm)");
    expect(calculate("sin(0)")).toBe("sin(0) = 0 (angles are in radians)");
    expect(calculate("cos(pi)")).toBe("cos(pi) = -1 (angles are in radians)");
    expect(calculate("sin(pi / 2) + tan(pi / 4)")).toBe("sin(pi / 2) + tan(pi / 4) = 2 (angles are in radians)");
    expect(calculate("asin(1) * 2")).toBe("asin(1) * 2 = 3.1415926535898 (angles are in radians)");
    expect(calculate("atan2(1, 1) * 4 + acos(1) + atan(0)")).toMatch(/ = 3\.1415926535898 \(angles are in radians\)$/);
    expect(calculate("10 % -3")).toBe("10 % -3 = -2.9 (% was read as a percentage; for a remainder write mod(a, b))");
    expect(calculate("10% - 3")).toBe("10% - 3 = -2.9 (% was read as a percentage; for a remainder write mod(a, b))");
  });

  it("accepts a trailing equals sign, pasted signs and surrounding space", () => {
    expect(calculate("2 + 2 =")).toBe("2 + 2 = 4");
    expect(calculate("  6 × 7 ÷ 2  ")).toBe("6 × 7 ÷ 2 = 21");
    expect(calculate("5 − 3")).toBe("5 − 3 = 2");
    expect(evaluate("2 * 21")).toEqual({ expression: "2 * 21", value: 42, result: "42", notes: [] });
  });

  it("formats numbers without float noise, and exactly only while they are exact", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(formatNumber(-(2 ** 60))).toBe("-1.1529215046068e+18");
    expect(formatNumber(1234.5)).toBe("1234.5");
    expect(formatNumber(1e-7)).toBe("1e-7");
    expect(formatNumber(123456789.123456789)).toBe("123456789.12346");
  });

  it.each([
    ["1 / 0", /^Division by zero\.$/],
    ["5 / (2 - 2)", /^Division by zero\.$/],
    ["5 % 0", /^Division by zero \(modulo 0\)\.$/],
    ["mod(1, 0)", /^Division by zero/],
    ["0 ^ -1", /^Division by zero \(0 to a negative power\)\.$/],
  ])("names a division by zero: %s", (expression, message) => {
    expect(() => calculate(expression)).toThrow(ToolError);
    expect(() => calculate(expression)).toThrow(message);
  });

  it.each([
    ["sqrt(-1)", /^Domain error: sqrt\(-1\) is not a real number\.$/],
    ["log(0)", /^Domain error: log\(0\) is undefined; log needs a number above 0\.$/],
    ["ln(-1)", /^Domain error: ln\(-1\) is undefined/],
    ["log10(0)", /^Domain error: log10\(0\)/],
    ["log2(-4)", /^Domain error: log2\(-4\)/],
    ["log(8, 1)", /^Domain error: log\(x, base\) needs a base above 0 that is not 1\.$/],
    ["asin(2)", /^Domain error: asin\(2\) is undefined; asin needs a number from -1 to 1\.$/],
    ["acos(-1.5)", /^Domain error: acos\(-1\.5\)/],
    ["(-8) ^ (1 / 3)", /^Domain error: -8 \^ 0\.33333333333333 is not a real number/],
    ["(-1)!", /^Domain error: -1! is undefined; factorial needs a whole number from 0 to 170\.$/],
    ["2.5!", /^Domain error: 2\.5! is undefined/],
    ["round(1.5, 0.5)", /^Domain error: round\(x, digits\) needs a whole number of digits/],
  ])("names a domain error: %s", (expression, message) => {
    expect(() => calculate(expression)).toThrow(ToolError);
    expect(() => calculate(expression)).toThrow(message);
  });

  it.each([
    ["1e308 * 10", /^Overflow: the product is too large to represent\.$/],
    ["1e308 + 1e308", /^Overflow: the sum is too large/],
    ["10 ^ 400", /^Overflow: the power is too large/],
    ["171!", /^Overflow: 171! is too large to represent \(170! is the largest\)\.$/],
    ["exp(1000)", /^Overflow: exp\(1000\) is too large/],
    ["1e999", /^Overflow: 1e999 at position 1 is too large/],
  ])("names an overflow: %s", (expression, message) => {
    expect(() => calculate(expression)).toThrow(ToolError);
    expect(() => calculate(expression)).toThrow(message);
  });

  it.each([
    ["foo + 1", /^Unknown name "foo" at position 1\. Supported: /],
    ["2 * bar(3)", /^Unknown name "bar" at position 5\. Supported: /],
    ["constructor", /^Unknown name "constructor" at position 1\./],
    ["toString(1)", /^Unknown name "tostring" at position 1\./],
    ["x + 5", /^Unknown name "x" at position 1\./],
  ])("points at an unknown name and lists what is supported: %s", (expression, message) => {
    expect(() => calculate(expression)).toThrow(ToolError);
    expect(() => calculate(expression)).toThrow(message);
    expect(() => calculate(expression)).toThrow(/functions sqrt cbrt abs round/);
  });

  it.each([
    ["2 +", /^Syntax error at position 4: expected a number, a name or "\(" but found the end of the expression\. Supported: /],
    ["2 * (3 + 4", /^Syntax error at position 11: expected "\)" to close the "\(" at position 5 but found the end/],
    ["2 * )", /^Syntax error at position 5: expected a number, a name or "\(" but found "\)"/],
    ["()", /^Syntax error at position 2: /],
    ["2 3", /^Syntax error at position 3: unexpected "3"\. There is no implicit multiplication/],
    ["2pi", /^Syntax error at position 2: unexpected "pi"\. There is no implicit multiplication/],
    ["2(3)", /^Syntax error at position 2: unexpected "\("\./],
    ["2 $ 3", /^Syntax error at position 3: unexpected "\$"\./],
    ["3 * * 4", /^Syntax error at position 5: /],
    ["x = 5", /^Syntax error at position 3: unexpected "="\./],
    ["1,000", /^Syntax error at position 2: unexpected ","\. A comma only separates the arguments of a function, so write 1000 or 1_000 rather than 1,000\./],
    ["1,000 + 5", /^Syntax error at position 2: unexpected ","/],
    ["sqrt", /^Syntax error at position 1: sqrt is a function and needs arguments, as in sqrt\(2\)\./],
    ["5 of 3", /^Syntax error at position 3: "of" only follows a percentage/],
    ["1__0", /^Syntax error at position 2: /],
    ["", /^The expression is empty\. Supported: /],
    ["   ", /^The expression is empty\./],
    ["sqrt()", /^sqrt\(\) at position 1 takes 1 argument, not 0\.$/],
    ["sqrt(1, 2)", /^sqrt\(\) at position 1 takes 1 argument, not 2\.$/],
    ["2 + atan2(1)", /^atan2\(\) at position 5 takes 2 arguments, not 1\.$/],
    ["round(1, 2, 3)", /^round\(\) at position 1 takes 1 or 2 arguments, not 3\.$/],
    ["min()", /^min\(\) at position 1 takes at least 1 arguments, not 0\.$/],
  ])("points at a syntax error: %j", (expression, message) => {
    expect(() => calculate(expression)).toThrow(ToolError);
    expect(() => calculate(expression)).toThrow(message);
  });

  it("refuses an expression that is too long, and takes one at the limit", () => {
    const atLimit = `${"1+".repeat(499)}11`;
    expect(atLimit).toHaveLength(MAX_EXPRESSION_LENGTH);
    expect(evaluate(atLimit).value).toBe(510);
    expect(() => calculate(`${atLimit}1`)).toThrow(ToolError);
    expect(() => calculate(`${atLimit}1`)).toThrow(/^The expression is 1001 characters long; the limit is 1000\./);
    // Long is not deep: a thousand signs or operators in a row are fine.
    expect(evaluate(`${"-".repeat(999)}1`).value).toBe(-1);
    expect(evaluate(`2${"*1".repeat(499)}`).value).toBe(2);
  });

  it("refuses an expression that is nested too deep, and takes one at the limit", () => {
    const nested = (depth: number) => `${"(".repeat(depth)}1${")".repeat(depth)}`;
    expect(evaluate(nested(MAX_DEPTH)).value).toBe(1);
    expect(() => calculate(nested(MAX_DEPTH + 1))).toThrow(ToolError);
    expect(() => calculate(nested(MAX_DEPTH + 1))).toThrow(/nested more than 100 levels deep/);
    expect(() => calculate(`${"abs(".repeat(101)}1${")".repeat(101)}`)).toThrow(/nested more than 100 levels deep/);
    expect(evaluate(`1${"^1".repeat(100)}`).value).toBe(1);
    expect(() => calculate(`1${"^1".repeat(200)}`)).toThrow(/nested more than 100 levels deep/);
  });

  it("never hands the expression to the JavaScript engine", () => {
    const source = readFileSync(join(__dirname, "lib", "calculate.ts"), "utf-8");
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new\s+Function/);
    expect(source).not.toMatch(/\bFunction\s*\(/);
    expect(source).not.toMatch(/["'](node:)?vm["']/);
    expect(source).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
    // And nothing reachable through a name: these would be properties of an ordinary object.
    for (const name of ["constructor", "__proto__", "valueOf", "hasOwnProperty", "process", "globalThis"]) {
      expect(() => calculate(name)).toThrow(/^Unknown name/);
      expect(() => calculate(`${name}(1)`)).toThrow(/^Unknown name/);
    }
  });
});

describe("current_time", () => {
  const at = (iso: string, timezone?: string) => formatCurrentTime(new Date(iso), timezone);

  it("gives the date, time, zone, ISO timestamp, week and day of year", () => {
    expect(at("2026-10-06T13:03:27Z", "Europe/Lisbon")).toBe(
      [
        "Tuesday, 6 October 2026, 14:03:27",
        "Time zone: Europe/Lisbon (UTC+01:00)",
        "ISO 8601: 2026-10-06T14:03:27+01:00",
        "ISO week 41 of 2026, day 279 of the year",
      ].join("\n"),
    );
  });

  it("handles UTC, midnight and fractions of a second", () => {
    expect(at("2026-10-06T00:00:00.999Z", "UTC")).toBe(
      ["Tuesday, 6 October 2026, 00:00:00", "Time zone: UTC (UTC+00:00)", "ISO 8601: 2026-10-06T00:00:00+00:00", "ISO week 41 of 2026, day 279 of the year"].join(
        "\n",
      ),
    );
  });

  it("handles half-hour offsets, east and west", () => {
    const india = at("2026-10-06T13:03:27Z", "Asia/Kolkata");
    expect(india).toContain("Tuesday, 6 October 2026, 18:33:27");
    expect(india).toContain("Time zone: Asia/Kolkata (UTC+05:30)");
    expect(india).toContain("ISO 8601: 2026-10-06T18:33:27+05:30");
    const newfoundland = at("2026-10-06T01:03:27Z", "America/St_Johns");
    expect(newfoundland).toContain("Monday, 5 October 2026, 22:33:27");
    expect(newfoundland).toContain("(UTC-02:30)");
    expect(newfoundland).toContain("ISO 8601: 2026-10-05T22:33:27-02:30");
    expect(newfoundland).toContain("ISO week 41 of 2026, day 278 of the year");
  });

  it("follows daylight saving time across its boundaries", () => {
    // Lisbon's clocks go from 01:00 to 02:00 on the last Sunday of March.
    expect(at("2026-03-29T00:59:59Z", "Europe/Lisbon")).toContain("ISO 8601: 2026-03-29T00:59:59+00:00");
    expect(at("2026-03-29T01:00:00Z", "Europe/Lisbon")).toContain("ISO 8601: 2026-03-29T02:00:00+01:00");
    // New York's go back from 02:00 to 01:00 on the first Sunday of November.
    expect(at("2026-11-01T05:59:59Z", "America/New_York")).toContain("ISO 8601: 2026-11-01T01:59:59-04:00");
    expect(at("2026-11-01T06:00:00Z", "America/New_York")).toContain("ISO 8601: 2026-11-01T01:00:00-05:00");
  });

  it.each([
    ["2021-01-01T12:00:00Z", "Friday, 1 January 2021", "ISO week 53 of 2020, day 1 of the year"],
    ["2023-01-01T12:00:00Z", "Sunday, 1 January 2023", "ISO week 52 of 2022, day 1 of the year"],
    ["2022-01-01T12:00:00Z", "Saturday, 1 January 2022", "ISO week 52 of 2021, day 1 of the year"],
    ["2026-01-01T12:00:00Z", "Thursday, 1 January 2026", "ISO week 1 of 2026, day 1 of the year"],
    ["2024-12-30T12:00:00Z", "Monday, 30 December 2024", "ISO week 1 of 2025, day 365 of the year"],
    ["2020-12-31T12:00:00Z", "Thursday, 31 December 2020", "ISO week 53 of 2020, day 366 of the year"],
    ["2024-02-29T12:00:00Z", "Thursday, 29 February 2024", "ISO week 9 of 2024, day 60 of the year"],
  ])("numbers the week and day around the turn of the year: %s", (instant, date, week) => {
    const text = at(instant, "UTC");
    expect(text.split("\n")[0]).toBe(`${date}, 12:00:00`);
    expect(text.split("\n")[3]).toBe(week);
  });

  it("uses the zone's own date, which can be another day or year", () => {
    const auckland = at("2026-12-31T23:30:00Z", "Pacific/Auckland");
    expect(auckland).toContain("Friday, 1 January 2027, 12:30:00");
    expect(auckland).toContain("(UTC+13:00)");
    expect(auckland).toContain("ISO week 53 of 2026, day 1 of the year");
  });

  it("defaults to the system's zone", () => {
    const now = new Date("2026-10-06T13:03:27Z");
    expect(at("2026-10-06T13:03:27Z")).toContain(`Time zone: ${systemTimeZone()} (UTC`);
    expect(at("2026-10-06T13:03:27Z", "  ")).toBe(at("2026-10-06T13:03:27Z"));
    expect(zonedTime(now).timeZone).toBe(systemTimeZone());
    // Whatever the zone, the timestamp names the same instant.
    for (const zone of [undefined, "Asia/Kolkata", "America/St_Johns", "Pacific/Auckland"]) {
      const iso = formatCurrentTime(now, zone).match(/ISO 8601: (\S+)/)![1];
      expect(new Date(iso).getTime()).toBe(now.getTime());
    }
  });

  it("explains a zone that does not exist", () => {
    expect(() => at("2026-10-06T13:03:27Z", "Mars/Phobos")).toThrow(ToolError);
    expect(() => at("2026-10-06T13:03:27Z", "Mars/Phobos")).toThrow(
      '"Mars/Phobos" is not a time zone. Use an IANA name such as Europe/Lisbon, America/New_York or Asia/Kolkata.',
    );
    expect(() => at("2026-10-06T13:03:27Z", "Lisbon time")).toThrow(/is not a time zone/);
  });
});

describe("utilities tools", () => {
  const tools = makeUtilityTools({ now: () => new Date("2026-10-06T13:03:27Z") });

  it("offers calculate and current_time, with short descriptions that say when to use them", async () => {
    expect(tools.map(t => t.name)).toEqual(["calculate", "current_time"]);
    expect((await toolsProvider({} as any)).map(t => t.name)).toEqual(["calculate", "current_time"]);
    expect(tools[0].description).toContain("use this instead of doing arithmetic yourself");
    expect(tools[1].description).toContain("You do not know today's date; call this");
    for (const tool of tools) expect(tool.description.length).toBeLessThan(260);
  });

  it("calculates, and returns mistakes as Error strings the model can act on", async () => {
    expect(await callTool(tools, "calculate", { expression: "15% of 240" })).toBe("15% of 240 = 36");
    expect(await callTool(tools, "calculate", { expression: "1 / 0" })).toBe("Error: Division by zero.");
    expect(await callTool(tools, "calculate", { expression: "2 + two" })).toMatch(/^Error: Unknown name "two" at position 5\./);
    expect(await callTool(tools, "calculate", { expression: "x".repeat(1001) })).toMatch(/^Error: The expression is 1001 characters long/);
  });

  it("tells the time from the injected clock", async () => {
    expect(await callTool(tools, "current_time", { timezone: "Asia/Kolkata" })).toBe(
      ["Tuesday, 6 October 2026, 18:33:27", "Time zone: Asia/Kolkata (UTC+05:30)", "ISO 8601: 2026-10-06T18:33:27+05:30", "ISO week 41 of 2026, day 279 of the year"].join(
        "\n",
      ),
    );
    expect(await callTool(tools, "current_time", {})).toContain("2026");
    expect(await callTool(tools, "current_time", { timezone: "Nowhere/Land" })).toMatch(/^Error: "Nowhere\/Land" is not a time zone\./);
  });

  it("reads the real clock when none is injected", async () => {
    const before = Date.now();
    const text = String(await callTool(makeUtilityTools(), "current_time", { timezone: "UTC" }));
    const reported = new Date(text.match(/ISO 8601: (\S+)/)![1]).getTime();
    expect(reported).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(reported).toBeLessThanOrEqual(Date.now());
  });
});
