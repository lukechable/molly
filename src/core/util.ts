import { createHash } from 'node:crypto';

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Renders `{{field}}` / `{{field:url}}` placeholders with credential values. */
export function renderTemplate(tpl: string, values: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)(?::(\w+))?\s*\}\}/g, (_, field: string, filter?: string) => {
    const v = values[field];
    if (v === undefined) throw new Error(`template references unknown field "${field}"`);
    return filter === 'url' ? encodeURIComponent(v) : v;
  });
}

/** If `tpl` is just one placeholder, returns that field name. */
export function plainField(tpl: string): string | undefined {
  return /^\{\{\s*(\w+)\s*\}\}$/.exec(tpl)?.[1];
}

export function mask(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, Math.min(7, Math.floor(value.length / 4)))}…${value.slice(-4)}`;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Distinct local repos a set of credentials touches. */
export function repoCount(creds: { targets: { type: string; repo?: string }[] }[]): number {
  return new Set(creds.flatMap((c) => c.targets.filter((t) => t.type === 'dotenv').map((t) => t.repo))).size;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function since(iso?: string): string {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  /** Resolve (instead of throwing) for these statuses. */
  allow?: number[];
}

/** Minimal JSON fetch wrapper. Error messages never include request bodies (they may hold secrets). */
export async function request<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'molly-cli', ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  }
  const res = await fetch(url, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body });
  const text = await res.text();
  if (!res.ok && !opts.allow?.includes(res.status)) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.error?.message ?? j.message ?? j.errors?.[0]?.message ?? j.errors?.[0] ?? j.error ?? detail;
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {}
    const host = new URL(url).host;
    throw new HttpError(res.status, `${host} returned ${res.status}: ${detail}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export const basic = (user: string, pass: string) => ({
  authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64'),
});
