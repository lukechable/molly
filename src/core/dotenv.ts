import { promises as fs } from 'node:fs';

export interface DotenvEntry {
  key: string;
  value: string;
  /** Character offsets of the raw value (including quotes) inside the source. */
  start: number;
  end: number;
  quote: '' | '"' | "'" | '`';
}

const LINE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/;

/** Parses a .env file, keeping enough positional info to rewrite values in place. */
export function parseDotenv(src: string): DotenvEntry[] {
  const out: DotenvEntry[] = [];
  let pos = 0;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const lineEnd = nl === -1 ? src.length : nl;
    const line = src.slice(pos, lineEnd);
    const m = LINE.exec(line);
    if (!m) {
      pos = lineEnd + 1;
      continue;
    }
    const start = pos + m[0].length;
    const first = src[start];
    if (first === '"' || first === "'" || first === '`') {
      const close = findClosingQuote(src, start + 1, first);
      if (close === -1) {
        pos = lineEnd + 1;
        continue;
      }
      let value = src.slice(start + 1, close);
      if (first === '"') value = value.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
      out.push({ key: m[1], value, start, end: close + 1, quote: first });
      const after = src.indexOf('\n', close);
      pos = after === -1 ? src.length : after + 1;
    } else {
      let raw = src.slice(start, lineEnd);
      const comment = raw.search(/\s#/);
      if (comment !== -1) raw = raw.slice(0, comment);
      raw = raw.replace(/[ \t\r]+$/, '');
      out.push({ key: m[1], value: raw, start, end: start + raw.length, quote: '' });
      pos = lineEnd + 1;
    }
  }
  return out;
}

function findClosingQuote(src: string, from: number, q: string): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === '\\' && q === '"') {
      i++;
      continue;
    }
    if (src[i] === q) return i;
  }
  return -1;
}

function encode(value: string, quote: DotenvEntry['quote']): string {
  if (quote === "'" && !value.includes("'") && !value.includes('\n')) return `'${value}'`;
  if (quote === '' && /^[^\s"'`#\\]*$/.test(value)) return value;
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

/** Returns `src` with every assignment of `key` set to `value`, formatting preserved. */
export function setDotenvValue(src: string, key: string, value: string): { text: string; count: number } {
  const entries = parseDotenv(src).filter((e) => e.key === key);
  let text = src;
  for (const e of [...entries].reverse()) {
    text = text.slice(0, e.start) + encode(value, e.quote) + text.slice(e.end);
  }
  return { text, count: entries.length };
}

export async function readDotenv(file: string): Promise<Map<string, string>> {
  const src = await fs.readFile(file, 'utf8');
  const map = new Map<string, string>();
  for (const e of parseDotenv(src)) if (!map.has(e.key)) map.set(e.key, e.value);
  return map;
}

/** Atomically rewrites `key` in `file`, preserving permissions. */
export async function writeDotenvValue(file: string, key: string, value: string): Promise<void> {
  const src = await fs.readFile(file, 'utf8');
  const { text, count } = setDotenvValue(src, key, value);
  if (count === 0) throw new Error(`${key} is no longer in ${file}`);
  const stat = await fs.stat(file);
  const tmp = `${file}.molly-${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: stat.mode & 0o777 });
  await fs.rename(tmp, file);
}
