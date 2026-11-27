// Formulas, in the language Notion's formula property uses (formulas 2.0): `prop("Price") * 2`,
// `if(prop("Done"), "✅", "…")`, `dateBetween(prop("Due"), now(), "days")`, `prop("Tags").map(current.upper())`.
// Shared by the app and the server (the AI connection), so a formula gives the same answer in both.
// Pure: no DOM, no Yjs.

/** A formula value. Dates carry whether they have a time; pages and people come from relations and person properties. */
export type FValue = number | string | boolean | null | FDate | FPage | FPerson | FValue[];
export interface FDate {
  kind: "date";
  start: number; // ms
  end?: number;
  time: boolean;
}
export interface FPage {
  kind: "page";
  id: string;
}
export interface FPerson {
  kind: "person";
  id: string;
}

export class FormulaError extends Error {}
const err = (m: string): never => {
  throw new FormulaError(m);
};

export const isDate = (v: unknown): v is FDate => !!v && typeof v === "object" && (v as any).kind === "date";
export const isPage = (v: unknown): v is FPage => !!v && typeof v === "object" && (v as any).kind === "page";
export const isPerson = (v: unknown): v is FPerson => !!v && typeof v === "object" && (v as any).kind === "person";

/** What a formula can reach: the row's properties, other rows (through relations) and people. */
export interface FormulaEnv {
  /** A property's value on a row, by property name (case-insensitive), or undefined if there's no such property. */
  prop(rowId: string, name: string): FValue | undefined;
  /** A row's title. */
  title(rowId: string): string;
  /** A person's name and email. */
  person(id: string): { name: string; email: string };
  now: number;
}

// ---------------------------------------------------------------- tokens

type Tok =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", ",", "(", ")", "[", "]", "."];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === "“" || c === "”") {
      const close = c === "“" ? "”" : c;
      let s = "";
      let j = i + 1;
      for (; j < src.length && src[j] !== close && !(close === "”" && src[j] === '"'); j++) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[++j];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
        } else s += src[j];
      }
      if (j >= src.length) err("A text value is missing its closing quote.");
      out.push({ t: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    // Letters beyond ASCII may name things, except the operator signs × ÷ ≠ ≤ ≥.
    if (/[A-Za-z_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u225F\u2266-\uFFFF]/.test(c)) {
      const m = /^[A-Za-z_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u225F\u2266-\uFFFF][A-Za-z0-9_\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u225F\u2266-\uFFFF]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? (c === "≠" ? "!=" : c === "≤" ? "<=" : c === "≥" ? ">=" : c === "×" ? "*" : c === "÷" ? "/" : null);
    if (!op) err(`Unexpected "${c}".`);
    out.push({ t: "op", v: op!, at: i });
    i += OPS.includes(op!) ? op!.length : 1;
  }
  out.push({ t: "end", at: src.length });
  return out;
}

// ---------------------------------------------------------------- parse

export type Node =
  | { k: "lit"; v: FValue }
  | { k: "id"; name: string }
  | { k: "list"; items: Node[] }
  | { k: "un"; op: string; a: Node }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "cond"; c: Node; a: Node; b: Node }
  | { k: "call"; name: string; args: Node[] };

export function parse(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek().t === "op" && (peek() as any).v === v;
  const isWord = (v: string) => peek().t === "id" && (peek() as any).v.toLowerCase() === v;
  const expect = (v: string) => {
    if (!isOp(v)) err(`Expected "${v}"${peek().t === "end" ? " at the end" : ""}.`);
    p++;
  };

  function expr(): Node {
    return ternary();
  }
  function ternary(): Node {
    const c = or();
    if (isOp("?")) {
      p++;
      const a = expr();
      expect(":");
      const b = expr();
      return { k: "cond", c, a, b };
    }
    return c;
  }
  function or(): Node {
    let a = and();
    while (isOp("||") || isWord("or")) {
      p++;
      a = { k: "bin", op: "or", a, b: and() };
    }
    return a;
  }
  function and(): Node {
    let a = not();
    while (isOp("&&") || isWord("and")) {
      p++;
      a = { k: "bin", op: "and", a, b: not() };
    }
    return a;
  }
  function not(): Node {
    if (isWord("not") && !(toks[p + 1]?.t === "op" && (toks[p + 1] as any).v === "(")) {
      p++;
      return { k: "un", op: "!", a: not() };
    }
    return cmp();
  }
  function cmp(): Node {
    let a = add();
    while (["==", "!=", "<", ">", "<=", ">="].some(isOp)) {
      const op = (toks[p++] as any).v;
      a = { k: "bin", op, a, b: add() };
    }
    return a;
  }
  function add(): Node {
    let a = mul();
    while (isOp("+") || isOp("-")) {
      const op = (toks[p++] as any).v;
      a = { k: "bin", op, a, b: mul() };
    }
    return a;
  }
  function mul(): Node {
    let a = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = (toks[p++] as any).v;
      a = { k: "bin", op, a, b: unary() };
    }
    return a;
  }
  function unary(): Node {
    if (isOp("-") || isOp("!") || isOp("+")) {
      const op = (toks[p++] as any).v;
      return { k: "un", op, a: unary() };
    }
    return pow();
  }
  function pow(): Node {
    const a = postfix();
    if (isOp("^")) {
      p++;
      return { k: "bin", op: "^", a, b: unary() };
    }
    return a;
  }
  function args(): Node[] {
    expect("(");
    const list: Node[] = [];
    if (!isOp(")")) {
      list.push(expr());
      while (isOp(",")) {
        p++;
        if (isOp(")")) break;
        list.push(expr());
      }
    }
    expect(")");
    return list;
  }
  function postfix(): Node {
    let n = primary();
    for (;;) {
      if (isOp(".")) {
        p++;
        const t = peek();
        if (t.t !== "id") err("Expected a function name after the dot.");
        p++;
        const name = (t as any).v;
        n = { k: "call", name, args: [n, ...(isOp("(") ? args() : [])] };
      } else if (isOp("[")) {
        p++;
        const i = expr();
        expect("]");
        n = { k: "call", name: "at", args: [n, i] };
      } else return n;
    }
  }
  function primary(): Node {
    const t = peek();
    if (t.t === "num") return p++, { k: "lit", v: t.v };
    if (t.t === "str") return p++, { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") {
      p++;
      const e = expr();
      expect(")");
      return e;
    }
    if (t.t === "op" && t.v === "[") {
      p++;
      const items: Node[] = [];
      if (!isOp("]")) {
        items.push(expr());
        while (isOp(",")) {
          p++;
          if (isOp("]")) break;
          items.push(expr());
        }
      }
      expect("]");
      return { k: "list", items };
    }
    if (t.t === "id") {
      p++;
      const low = t.v.toLowerCase();
      if (low === "true") return { k: "lit", v: true };
      if (low === "false") return { k: "lit", v: false };
      if (isOp("(")) return { k: "call", name: t.v, args: args() };
      return { k: "id", name: t.v };
    }
    if (t.t === "end") err("The formula ends too early.");
    return err(`Unexpected "${(t as any).v}".`);
  }

  if (!src.trim()) return { k: "lit", v: null };
  const n = expr();
  if (peek().t !== "end") err(`Unexpected "${(peek() as any).v ?? ""}".`);
  return n;
}

// ---------------------------------------------------------------- helpers

const DAY = 86_400_000;
const UNITS: Record<string, string> = {
  year: "years", years: "years", y: "years",
  quarter: "quarters", quarters: "quarters",
  month: "months", months: "months", M: "months",
  week: "weeks", weeks: "weeks", w: "weeks",
  day: "days", days: "days", d: "days",
  hour: "hours", hours: "hours", h: "hours",
  minute: "minutes", minutes: "minutes", m: "minutes",
  second: "seconds", seconds: "seconds", s: "seconds",
  millisecond: "milliseconds", milliseconds: "milliseconds", ms: "milliseconds",
};
const unitOf = (u: FValue): string => ownGet(UNITS, String(u)) ?? ownGet(UNITS, String(u).toLowerCase()) ?? err(`"${u}" isn't a unit. Use years, quarters, months, weeks, days, hours, minutes or seconds.`);

/** A table's own entry for a key, never one inherited from Object.prototype ("constructor", "__proto__"…). */
function ownGet<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Moves a date by whole months, keeping the day of the month but stopping at the month's last day (Jan 31 + 1 month = Feb 28). */
function addMonths(d: Date, n: number): number {
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.getTime();
}

export function addTo(ms: number, n: number, unit: string): number {
  const d = new Date(ms);
  switch (unit) {
    case "years":
      return addMonths(d, 12 * n);
    case "quarters":
      return addMonths(d, 3 * n);
    case "months":
      return addMonths(d, n);
    case "weeks":
      return ms + n * 7 * DAY;
    case "days":
      d.setDate(d.getDate() + n);
      return d.getTime();
    case "hours":
      return ms + n * 3_600_000;
    case "minutes":
      return ms + n * 60_000;
    case "seconds":
      return ms + n * 1000;
    default:
      return ms + n;
  }
}
function between(a: number, b: number, unit: string): number {
  const da = new Date(a);
  const db = new Date(b);
  // Whole months: a month counts only once the day of the month is reached, in either direction.
  let months = (da.getFullYear() - db.getFullYear()) * 12 + (da.getMonth() - db.getMonth());
  if (months > 0 && da.getDate() < db.getDate()) months--;
  else if (months < 0 && da.getDate() > db.getDate()) months++;
  const trunc = (x: number) => (x < 0 ? Math.ceil(x) : Math.floor(x));
  // Days and weeks by the calendar, so a day with a daylight-saving change (23 or 25 hours) is still one day.
  const wall = (x: number, d: Date) => x - d.getTimezoneOffset() * 60_000;
  switch (unit) {
    case "years":
      return trunc(months / 12);
    case "quarters":
      return trunc(months / 3);
    case "months":
      return months;
    case "weeks":
      return trunc((wall(a, da) - wall(b, db)) / (7 * DAY));
    case "days":
      return trunc((wall(a, da) - wall(b, db)) / DAY);
    case "hours":
      return trunc((a - b) / 3_600_000);
    case "minutes":
      return trunc((a - b) / 60_000);
    case "seconds":
      return trunc((a - b) / 1000);
    default:
      return a - b;
  }
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const ordinal = (n: number) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return n + "th";
  return n + (["th", "st", "nd", "rd"][n % 10] ?? "th");
};

/** Formats a date with moment-style tokens (YYYY, MMMM, MMM, MM, M, DD, D, Do, dddd, ddd, HH, H, hh, h, mm, ss, A, a). */
export function formatWith(ms: number, fmt: string): string {
  const d = new Date(ms);
  const h12 = d.getHours() % 12 || 12;
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    Do: ordinal(d.getDate()),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    dddd: DAYS[d.getDay()],
    ddd: DAYS[d.getDay()].slice(0, 3),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(h12),
    h: String(h12),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    A: d.getHours() < 12 ? "AM" : "PM",
    a: d.getHours() < 12 ? "am" : "pm",
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g, (m, lit) => lit ?? map[m] ?? m);
}

/** "Nov 14, 2026" or "Nov 14, 2026 9:30 AM", the way dates show by default. */
export function defaultDateText(d: FDate): string {
  const one = (ms: number) => formatWith(ms, d.time ? "MMM D, YYYY h:mm A" : "MMM D, YYYY");
  return d.end != null && d.end !== d.start ? `${one(d.start)} → ${one(d.end)}` : one(d.start);
}

function numText(n: number): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? "NaN" : n > 0 ? "Infinity" : "-Infinity";
  return String(Math.round(n * 1e10) / 1e10);
}

/** A formula value as text. */
export function toText(v: FValue, env?: Pick<FormulaEnv, "title" | "person">): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return numText(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map((x) => toText(x, env)).join(", ");
  if (isDate(v)) return defaultDateText(v);
  if (isPage(v)) return env ? env.title(v.id) : v.id;
  if (isPerson(v)) return env ? env.person(v.id).name : v.id;
  return "";
}

const isEmpty = (v: FValue): boolean =>
  v == null || v === "" || v === 0 || v === false || (Array.isArray(v) && (v.length === 0 || v.every(isEmpty)));

function num(v: FValue, what = "This"): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v == null || v === "") return 0;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  if (isDate(v)) return v.start;
  return err(`${what} needs a number, not ${describe(v)}.`);
}
function str(v: FValue, env: FormulaEnv): string {
  return toText(v, env);
}
function date(v: FValue, what = "This"): FDate {
  if (isDate(v)) return v;
  if (typeof v === "number") return { kind: "date", start: v, time: true };
  if (typeof v === "string") {
    const d = parseDateText(v);
    if (d) return d;
  }
  return err(`${what} needs a date, not ${describe(v)}.`);
}
function list(v: FValue): FValue[] {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}
function describe(v: FValue): string {
  if (v == null) return "an empty value";
  if (Array.isArray(v)) return "a list";
  if (isDate(v)) return "a date";
  if (isPage(v)) return "a page";
  if (isPerson(v)) return "a person";
  return typeof v === "string" ? "text" : typeof v === "number" ? "a number" : "true/false";
}
export function parseDateText(s: string): FDate | null {
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (m) {
    const ms = new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0).getTime();
    return Number.isNaN(ms) ? null : { kind: "date", start: ms, time: !!m[4] };
  }
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : { kind: "date", start: ms, time: /\d:\d/.test(t) };
}
function equal(a: FValue, b: FValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = list(a);
    const y = list(b);
    return x.length === y.length && x.every((v, i) => equal(v, y[i]));
  }
  if (isDate(a) && isDate(b)) return a.start === b.start && (a.end ?? a.start) === (b.end ?? b.start);
  if ((isPage(a) && isPage(b)) || (isPerson(a) && isPerson(b))) return a.id === b.id;
  if (a == null || b == null) return (a == null || a === "") && (b == null || b === "");
  return a === b;
}
function order(a: FValue, b: FValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (isDate(a) && isDate(b)) return a.start - b.start;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return toText(a).localeCompare(toText(b), undefined, { numeric: true });
}
function regex(p: FValue, flags = ""): RegExp {
  try {
    return new RegExp(String(p ?? ""), flags);
  } catch {
    return err(`"${p}" isn't a valid pattern.`);
  }
}
function round(n: number, places = 0) {
  const f = Math.pow(10, places);
  return Math.round(n * f) / f;
}
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function nums(args: FValue[]): number[] {
  return args.flatMap((a) => list(a)).filter((x) => x != null && x !== "").map((x) => num(x));
}
function isoWeek(ms: number) {
  const d = new Date(ms);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y.getTime()) / DAY + 1) / 7);
}
const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

// ---------------------------------------------------------------- functions

type Scope = Map<string, FValue>;
interface Ev {
  env: FormulaEnv;
  rowId: string;
  depth: number;
}
type Fn = (args: Node[], ev: Ev, scope: Scope) => FValue;
const eager = (f: (v: FValue[], ev: Ev) => FValue): Fn => (args, ev, scope) => f(args.map((a) => evalNode(a, ev, scope)), ev);
const arity = (name: string, v: unknown[], min: number, max = min) => {
  if (v.length < min || v.length > max) err(`${name}() takes ${min === max ? min : `${min} to ${max}`} value${max === 1 ? "" : "s"}.`);
};
/** Runs fn for every item of a list with `current` (and `index`) set, as map(), filter() and friends do. */
function eachItem(args: Node[], ev: Ev, scope: Scope, name: string, fn: (item: FValue, result: FValue, i: number) => boolean | void) {
  arity(name, args, 2);
  const items = list(evalNode(args[0], ev, scope));
  for (let i = 0; i < items.length; i++) {
    const s = new Map(scope);
    s.set("current", items[i]);
    s.set("index", i);
    if (fn(items[i], evalNode(args[1], ev, s), i) === false) break;
  }
}

const FNS: Record<string, Fn> = {
  // logic
  if: (args, ev, scope) => {
    arity("if", args, 3);
    return truthy(evalNode(args[0], ev, scope)) ? evalNode(args[1], ev, scope) : evalNode(args[2], ev, scope);
  },
  ifs: (args, ev, scope) => {
    for (let i = 0; i + 1 < args.length; i += 2) if (truthy(evalNode(args[i], ev, scope))) return evalNode(args[i + 1], ev, scope);
    return args.length % 2 ? evalNode(args[args.length - 1], ev, scope) : null;
  },
  and: (args, ev, scope) => args.every((a) => truthy(evalNode(a, ev, scope))),
  or: (args, ev, scope) => args.some((a) => truthy(evalNode(a, ev, scope))),
  not: eager((v) => (arity("not", v, 1), !truthy(v[0]))),
  empty: eager((v) => (arity("empty", v, 1), isEmpty(v[0]))),
  equal: eager((v) => (arity("equal", v, 2), equal(v[0], v[1]))),
  unequal: eager((v) => (arity("unequal", v, 2), !equal(v[0], v[1]))),
  let: (args, ev, scope) => {
    arity("let", args, 3);
    if (args[0].k !== "id") err("let() needs a name first, like let(x, 1, x + 1).");
    const s = new Map(scope);
    s.set((args[0] as any).name, evalNode(args[1], ev, scope));
    return evalNode(args[2], ev, s);
  },
  lets: (args, ev, scope) => {
    if (args.length < 3 || args.length % 2 === 0) err("lets() takes names and values in pairs, then the result.");
    const s = new Map(scope);
    for (let i = 0; i + 1 < args.length; i += 2) {
      if (args[i].k !== "id") err("lets() needs a name before each value.");
      s.set((args[i] as any).name, evalNode(args[i + 1], ev, s));
    }
    return evalNode(args[args.length - 1], ev, s);
  },

  // text
  length: eager((v, ev) => (arity("length", v, 1), Array.isArray(v[0]) ? v[0].length : str(v[0], ev.env).length)),
  substring: eager((v, ev) => (arity("substring", v, 2, 3), str(v[0], ev.env).substring(num(v[1]), v[2] == null ? undefined : num(v[2])))),
  contains: eager((v, ev) => (arity("contains", v, 2), Array.isArray(v[0]) ? v[0].some((x) => equal(x, v[1]) || str(x, ev.env) === str(v[1], ev.env)) : str(v[0], ev.env).includes(str(v[1], ev.env)))),
  test: eager((v, ev) => (arity("test", v, 2), regex(v[1]).test(str(v[0], ev.env)))),
  match: eager((v, ev) => (arity("match", v, 2), str(v[0], ev.env).match(regex(v[1], "g")) ?? [])),
  replace: eager((v, ev) => (arity("replace", v, 3), str(v[0], ev.env).replace(regex(v[1]), str(v[2], ev.env)))),
  replaceAll: eager((v, ev) => (arity("replaceAll", v, 3), str(v[0], ev.env).replace(regex(v[1], "g"), str(v[2], ev.env)))),
  lower: eager((v, ev) => (arity("lower", v, 1), str(v[0], ev.env).toLowerCase())),
  upper: eager((v, ev) => (arity("upper", v, 1), str(v[0], ev.env).toUpperCase())),
  trim: eager((v, ev) => (arity("trim", v, 1), str(v[0], ev.env).trim())),
  repeat: eager((v, ev) => (arity("repeat", v, 2), str(v[0], ev.env).repeat(Math.max(0, Math.min(1000, num(v[1])))))),
  padStart: eager((v, ev) => (arity("padStart", v, 3), str(v[0], ev.env).padStart(Math.min(1000, num(v[1])), str(v[2], ev.env)))),
  padEnd: eager((v, ev) => (arity("padEnd", v, 3), str(v[0], ev.env).padEnd(Math.min(1000, num(v[1])), str(v[2], ev.env)))),
  link: eager((v, ev) => (arity("link", v, 2), str(v[0], ev.env))),
  style: eager((v) => v[0] ?? null),
  unstyle: eager((v, ev) => str(v[0], ev.env)),
  format: eager((v, ev) => (arity("format", v, 1), str(v[0], ev.env))),
  concat: eager((v, ev) => (v.every((x) => !Array.isArray(x)) ? v.map((x) => str(x, ev.env)).join("") : v.flatMap((x) => list(x)))),
  join: eager((v, ev) => (arity("join", v, 2), list(v[0]).map((x) => str(x, ev.env)).join(str(v[1], ev.env)))),
  split: eager((v, ev) => (arity("split", v, 2), str(v[0], ev.env).split(str(v[1], ev.env)))),
  toNumber: eager((v) => {
    arity("toNumber", v, 1);
    const x = v[0];
    if (typeof x === "number") return x;
    if (typeof x === "boolean") return x ? 1 : 0;
    if (isDate(x)) return x.start;
    const n = parseFloat(String(x ?? "").replace(/,/g, ""));
    return Number.isNaN(n) ? null : n;
  }),

  // numbers
  add: eager((v, ev) => (arity("add", v, 2), plus(v[0], v[1], ev))),
  subtract: eager((v) => (arity("subtract", v, 2), num(v[0]) - num(v[1]))),
  multiply: eager((v) => (arity("multiply", v, 2), num(v[0]) * num(v[1]))),
  divide: eager((v) => (arity("divide", v, 2), num(v[0]) / num(v[1]))),
  pow: eager((v) => (arity("pow", v, 2), Math.pow(num(v[0]), num(v[1])))),
  mod: eager((v) => (arity("mod", v, 2), num(v[0]) % num(v[1]))),
  abs: eager((v) => Math.abs(num(v[0]))),
  ceil: eager((v) => Math.ceil(num(v[0]))),
  floor: eager((v) => Math.floor(num(v[0]))),
  round: eager((v) => (arity("round", v, 1, 2), round(num(v[0]), v[1] == null ? 0 : num(v[1])))),
  sqrt: eager((v) => Math.sqrt(num(v[0]))),
  cbrt: eager((v) => Math.cbrt(num(v[0]))),
  exp: eager((v) => Math.exp(num(v[0]))),
  ln: eager((v) => Math.log(num(v[0]))),
  log10: eager((v) => Math.log10(num(v[0]))),
  log2: eager((v) => Math.log2(num(v[0]))),
  sign: eager((v) => Math.sign(num(v[0]))),
  pi: () => Math.PI,
  e: () => Math.E,
  max: eager((v) => {
    const xs = nums(v);
    return xs.length ? Math.max(...xs) : null;
  }),
  min: eager((v) => {
    const xs = nums(v);
    return xs.length ? Math.min(...xs) : null;
  }),
  sum: eager((v) => nums(v).reduce((a, b) => a + b, 0)),
  mean: eager((v) => {
    const xs = nums(v);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  }),
  median: eager((v) => median(nums(v))),
  unaryMinus: eager((v) => -num(v[0])),
  unaryPlus: eager((v) => num(v[0])),

  // dates
  now: (_a, ev) => ({ kind: "date", start: ev.env.now, time: true }),
  today: (_a, ev) => ({ kind: "date", start: startOfDay(ev.env.now), time: false }),
  minute: eager((v) => new Date(date(v[0]).start).getMinutes()),
  hour: eager((v) => new Date(date(v[0]).start).getHours()),
  day: eager((v) => new Date(date(v[0]).start).getDay()),
  date: eager((v) => new Date(date(v[0]).start).getDate()),
  week: eager((v) => isoWeek(date(v[0]).start)),
  month: eager((v) => new Date(date(v[0]).start).getMonth() + 1),
  year: eager((v) => new Date(date(v[0]).start).getFullYear()),
  dateAdd: eager((v) => {
    arity("dateAdd", v, 3);
    if (v[0] == null) return null;
    const d = date(v[0]);
    const u = unitOf(v[2]);
    return { ...d, start: addTo(d.start, num(v[1]), u), end: d.end == null ? undefined : addTo(d.end, num(v[1]), u) };
  }),
  dateSubtract: eager((v) => {
    arity("dateSubtract", v, 3);
    if (v[0] == null) return null;
    const d = date(v[0]);
    const u = unitOf(v[2]);
    return { ...d, start: addTo(d.start, -num(v[1]), u), end: d.end == null ? undefined : addTo(d.end, -num(v[1]), u) };
  }),
  dateBetween: eager((v) => {
    arity("dateBetween", v, 3);
    if (v[0] == null || v[1] == null) return null;
    return between(date(v[0]).start, date(v[1]).start, unitOf(v[2]));
  }),
  dateRange: eager((v) => {
    arity("dateRange", v, 2);
    const a = date(v[0]);
    const b = date(v[1]);
    return { kind: "date", start: a.start, end: b.end ?? b.start, time: a.time || b.time };
  }),
  dateStart: eager((v) => (v[0] == null ? null : { ...date(v[0]), end: undefined })),
  dateEnd: eager((v) => {
    if (v[0] == null) return null;
    const d = date(v[0]);
    return { kind: "date", start: d.end ?? d.start, time: d.time };
  }),
  timestamp: eager((v) => (v[0] == null ? null : date(v[0]).start)),
  fromTimestamp: eager((v) => ({ kind: "date", start: num(v[0]), time: true })),
  formatDate: eager((v, ev) => {
    arity("formatDate", v, 2);
    if (v[0] == null) return "";
    const d = date(v[0]);
    const f = str(v[1], ev.env);
    return d.end != null && d.end !== d.start ? `${formatWith(d.start, f)} → ${formatWith(d.end, f)}` : formatWith(d.start, f);
  }),
  parseDate: eager((v, ev) => parseDateText(str(v[0], ev.env)) ?? err(`"${str(v[0], ev.env)}" isn't a date Sandpiper can read. Try YYYY-MM-DD.`)),

  // people
  name: eager((v, ev) => {
    const x = Array.isArray(v[0]) ? v[0][0] : v[0];
    return isPerson(x) ? ev.env.person(x.id).name : isPage(x) ? ev.env.title(x.id) : str(x ?? null, ev.env);
  }),
  email: eager((v, ev) => {
    const x = Array.isArray(v[0]) ? v[0][0] : v[0];
    return isPerson(x) ? ev.env.person(x.id).email : "";
  }),

  // lists
  at: eager((v) => {
    arity("at", v, 2);
    const l = list(v[0]);
    const i = num(v[1]);
    return l[i < 0 ? l.length + i : i] ?? null;
  }),
  first: eager((v) => list(v[0])[0] ?? null),
  last: eager((v) => {
    const l = list(v[0]);
    return l[l.length - 1] ?? null;
  }),
  slice: eager((v) => (arity("slice", v, 2, 3), list(v[0]).slice(num(v[1]), v[2] == null ? undefined : num(v[2])))),
  sort: (args, ev, scope) => {
    const items = [...list(evalNode(args[0], ev, scope))];
    if (args.length < 2) return items.sort(order);
    const keyed = items.map((item, i) => {
      const s = new Map(scope);
      s.set("current", item);
      s.set("index", i);
      return { item, key: evalNode(args[1], ev, s) };
    });
    return keyed.sort((a, b) => order(a.key, b.key)).map((x) => x.item);
  },
  reverse: eager((v) => [...list(v[0])].reverse()),
  unique: eager((v) => list(v[0]).filter((x, i, a) => a.findIndex((y) => equal(x, y)) === i)),
  includes: eager((v) => list(v[0]).some((x) => equal(x, v[1]))),
  flat: eager((v) => list(v[0]).flatMap((x) => list(x))),
  map: (args, ev, scope) => {
    const out: FValue[] = [];
    eachItem(args, ev, scope, "map", (_item, r) => void out.push(r));
    return out;
  },
  filter: (args, ev, scope) => {
    const out: FValue[] = [];
    eachItem(args, ev, scope, "filter", (item, r) => void (truthy(r) && out.push(item)));
    return out;
  },
  find: (args, ev, scope) => {
    let found: FValue = null;
    eachItem(args, ev, scope, "find", (item, r) => (truthy(r) ? ((found = item), false) : undefined));
    return found;
  },
  findIndex: (args, ev, scope) => {
    let found = -1;
    eachItem(args, ev, scope, "findIndex", (_item, r, i) => (truthy(r) ? ((found = i), false) : undefined));
    return found;
  },
  some: (args, ev, scope) => {
    let any = false;
    eachItem(args, ev, scope, "some", (_item, r) => (truthy(r) ? ((any = true), false) : undefined));
    return any;
  },
  every: (args, ev, scope) => {
    let all = true;
    eachItem(args, ev, scope, "every", (_item, r) => (!truthy(r) ? ((all = false), false) : undefined));
    return all;
  },
  count: eager((v) => list(v[0]).length),

  // rows
  id: eager((v, ev) => {
    const x = v[0];
    return isPage(x) ? x.id : isPerson(x) ? x.id : ev.rowId;
  }),
  prop: (args, ev, scope) => {
    // prop("Name") reads this row; page.prop("Name") reads a related page.
    if (args.length === 1) return readProp(ev, ev.rowId, str(evalNode(args[0], ev, scope), ev.env));
    arity("prop", args, 2);
    const target = evalNode(args[0], ev, scope);
    const name = str(evalNode(args[1], ev, scope), ev.env);
    if (Array.isArray(target)) return target.map((t) => (isPage(t) ? readProp(ev, t.id, name) : null));
    if (!isPage(target)) err(`.prop("${name}") works on pages from a relation.`);
    return readProp(ev, (target as FPage).id, name);
  },
};
// Old Notion names still found in formulas people paste.
FNS.larger = eager((v) => order(v[0], v[1]) > 0);
FNS.largerEq = eager((v) => order(v[0], v[1]) >= 0);
FNS.smaller = eager((v) => order(v[0], v[1]) < 0);
FNS.smallerEq = eager((v) => order(v[0], v[1]) <= 0);
FNS.start = FNS.dateStart;
FNS.end = FNS.dateEnd;
FNS.average = FNS.mean;
FNS.formatNumber = FNS.format;

/** The functions a formula can call, for the editor's help list. */
export const FUNCTION_NAMES = Object.keys(FNS).sort();

function readProp(ev: Ev, rowId: string, name: string): FValue {
  if (ev.depth > 12) err("Formulas refer to each other in a loop.");
  if (name.toLowerCase() === "name" || name.toLowerCase() === "title") {
    const v = ev.env.prop(rowId, name);
    return v === undefined ? ev.env.title(rowId) : v;
  }
  const v = ev.env.prop(rowId, name);
  if (v === undefined) err(`There's no property called "${name}".`);
  return v as FValue;
}

/** Empty text, 0, false, an empty list and no value count as false; anything else as true. */
export function truthy(v: FValue): boolean {
  return !isEmpty(v);
}

function plus(a: FValue, b: FValue, ev: Ev): FValue {
  if (typeof a === "string" || typeof b === "string") return str(a, ev.env) + str(b, ev.env);
  if (Array.isArray(a) || Array.isArray(b)) return [...list(a), ...list(b)];
  return num(a) + num(b);
}

function evalNode(n: Node, ev: Ev, scope: Scope): FValue {
  switch (n.k) {
    case "lit":
      return n.v;
    case "list":
      return n.items.map((i) => evalNode(i, ev, scope));
    case "id": {
      if (scope.has(n.name)) return scope.get(n.name)!;
      const low = n.name.toLowerCase();
      if (low === "pi") return Math.PI;
      if (low === "e") return Math.E;
      if (low === "current") return err("current only works inside map(), filter() and similar.");
      return err(`"${n.name}" isn't known. Use prop("${n.name}") to read a property.`);
    }
    case "un": {
      const a = evalNode(n.a, ev, scope);
      return n.op === "!" ? !truthy(a) : n.op === "-" ? -num(a) : num(a);
    }
    case "cond":
      return truthy(evalNode(n.c, ev, scope)) ? evalNode(n.a, ev, scope) : evalNode(n.b, ev, scope);
    case "bin": {
      if (n.op === "and") return truthy(evalNode(n.a, ev, scope)) && truthy(evalNode(n.b, ev, scope));
      if (n.op === "or") return truthy(evalNode(n.a, ev, scope)) || truthy(evalNode(n.b, ev, scope));
      const a = evalNode(n.a, ev, scope);
      const b = evalNode(n.b, ev, scope);
      switch (n.op) {
        case "+":
          return plus(a, b, ev);
        case "-":
          if (isDate(a) && isDate(b)) return a.start - b.start;
          return num(a) - num(b);
        case "*":
          return num(a) * num(b);
        case "/":
          return num(a) / num(b);
        case "%":
          return num(a) % num(b);
        case "^":
          return Math.pow(num(a), num(b));
        case "==":
          return equal(a, b);
        case "!=":
          return !equal(a, b);
        case "<":
          return order(a, b) < 0;
        case ">":
          return order(a, b) > 0;
        case "<=":
          return order(a, b) <= 0;
        case ">=":
          return order(a, b) >= 0;
      }
      return null;
    }
    case "call": {
      const fn = ownGet(FNS, n.name) ?? ownGet(FNS, Object.keys(FNS).find((k) => k.toLowerCase() === n.name.toLowerCase()) ?? "");
      if (!fn) return err(`There's no function called ${n.name}().`);
      return fn(n.args, ev, scope);
    }
  }
}

const parsed = new Map<string, Node | FormulaError>();

/** Checks a formula; returns the problem, or null if it reads fine. */
export function checkFormula(src: string): string | null {
  try {
    parse(src);
    return null;
  } catch (e) {
    return e instanceof FormulaError ? e.message : "This formula can't be read.";
  }
}

/** Evaluates a formula for one row. Throws FormulaError with a readable message when it can't. */
export function evaluate(src: string, rowId: string, env: FormulaEnv, depth = 0): FValue {
  let node = parsed.get(src);
  if (!node) {
    try {
      node = parse(src);
    } catch (e) {
      node = e instanceof FormulaError ? e : new FormulaError("This formula can't be read.");
    }
    if (parsed.size > 500) parsed.clear();
    parsed.set(src, node);
  }
  if (node instanceof FormulaError) throw node;
  try {
    return evalNode(node, { env, rowId, depth }, new Map());
  } catch (e) {
    if (e instanceof FormulaError) throw e;
    if (e instanceof RangeError) throw new FormulaError("This formula goes too deep.");
    throw new FormulaError("This formula couldn't be worked out.");
  }
}
