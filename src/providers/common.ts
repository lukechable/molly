import { fingerprint } from '../core/util.js';
import type { Detection } from './types.js';

const PLACEHOLDER = /^(|x+|\.+|changeme|change-me|todo|your[-_ ].*|<.*>|\$\{.*\}|replace[-_ ]?me|example|test|secret|null|undefined|\*+)$/i;

export function isPlaceholder(value: string): boolean {
  return PLACEHOLDER.test(value.trim()) || value.length < 12;
}

export interface SimpleRule {
  /** Variable names that belong to this provider (value must still look real). */
  names?: RegExp;
  /** Values that must match when the name matches. */
  shape?: RegExp;
  /** Values distinctive enough to claim regardless of the variable name. */
  prefix?: RegExp;
  /** Variable names to never claim (e.g. Clerk keys share Stripe's sk_live_ prefix). */
  exclude?: RegExp;
}

/** Detector for single-field credentials identified by name and/or value shape. */
export function simpleDetector(provider: string, field: string, rule: SimpleRule) {
  return (vars: Map<string, string>): Detection[] => {
    const out: Detection[] = [];
    for (const [key, value] of vars) {
      if (isPlaceholder(value) || rule.exclude?.test(key)) continue;
      const byName = rule.names?.test(key) && (!rule.shape || rule.shape.test(value));
      const byValue = rule.prefix?.test(value);
      if (!byName && !byValue) continue;
      out.push({ provider, identity: `${provider}:${fingerprint(value)}`, field, key, label: key, current: value });
    }
    return out;
  };
}

/** Pairs an id variable with its secret sibling, e.g. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY. */
export function pairedDetector(
  provider: string,
  idField: string,
  secretField: string,
  idShape: RegExp,
  idName: RegExp,
  secretNameFor: (idKey: string) => string[],
) {
  return (vars: Map<string, string>): Detection[] => {
    const out: Detection[] = [];
    for (const [key, value] of vars) {
      if (!idName.test(key) || !idShape.test(value)) continue;
      const secretKey = secretNameFor(key).find((k) => vars.has(k) && !isPlaceholder(vars.get(k)!));
      if (!secretKey) continue;
      const identity = `${provider}:${value}`;
      out.push({ provider, identity, field: idField, key, label: key, current: value });
      out.push({ provider, identity, field: secretField, key: secretKey, label: secretKey, current: vars.get(secretKey)! });
    }
    return out;
  };
}

/** Retries `fn` while it throws, for keys that take a few seconds to become valid. */
export async function eventually<T>(fn: () => Promise<T>, attempts = 6, delayMs = 2500): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

export const stamp = () => new Date().toISOString().slice(0, 10);
