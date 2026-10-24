import type { CredentialSpec } from '../core/config.js';

export type Category = 'ai' | 'cloud' | 'database' | 'payments' | 'email' | 'auth' | 'observability' | 'app' | 'code';

export const CATEGORIES: { id: Category; title: string; hint: string }[] = [
  { id: 'ai', title: 'AI & LLMs', hint: '' },
  { id: 'cloud', title: 'Cloud & infrastructure', hint: '' },
  { id: 'database', title: 'Databases', hint: '' },
  { id: 'payments', title: 'Payments', hint: '' },
  { id: 'email', title: 'Email & messaging', hint: '' },
  { id: 'auth', title: 'Auth & identity', hint: '' },
  { id: 'observability', title: 'Observability', hint: '' },
  { id: 'app', title: 'App secrets', hint: '' },
  { id: 'code', title: 'Where your repos keep secrets', hint: 'Molly updates these after each roll' },
];

/**
 * - auto:   Molly creates the new key and revokes the old one through the platform's API.
 * - guided: the platform has no key API; Molly opens the dashboard, you paste the new key,
 *           Molly verifies it and updates every repo.
 * - host:   not rotated itself; a place secrets get pushed to (GitHub, Vercel).
 */
export type Mode = 'auto' | 'guided' | 'host';

export interface AuthField {
  key: string;
  label: string;
  secret: boolean;
  help?: string;
  optional?: boolean;
  default?: string;
}

export interface ProviderContext {
  params: Record<string, string>;
  /** Reads a platform auth field (env var → keychain → auto-detected source). */
  auth(field: string): Promise<string>;
  authOptional(field: string): Promise<string | undefined>;
}

export interface Issued {
  /** Provider-side id of the new key, so the next roll can revoke it. */
  keyId?: string;
  values: Record<string, string>;
  /** True when issuing already invalidated the old value (in-place roll). */
  immediate?: boolean;
}

export interface Detection {
  provider: string;
  /** Grouping key: detections with the same identity are the same credential. */
  identity: string;
  field: string;
  key: string;
  /** Value template when the variable isn't just the raw secret (e.g. a database URL). */
  template?: string;
  label: string;
  params?: Record<string, string>;
  /** Current value of `field`, used during setup only and never persisted. */
  current: string;
}

export interface Question {
  param: string;
  prompt: string;
  options: { label: string; value: string }[];
}

export interface Guide {
  url: (cred: CredentialSpec, current: Record<string, string>) => string;
  steps: (cred: CredentialSpec, current: Record<string, string>) => string[];
  pattern?: RegExp;
  /** What to tell the user about the old key once everything is updated. */
  afterwards?: string;
}

export interface CliLogin {
  /** Shown as "Log in with <label>". */
  label: string;
  available(): Promise<boolean>;
  /** Runs with the terminal handed over to it. */
  run(): Promise<void>;
}

export interface Provider {
  id: string;
  name: string;
  category: Category;
  mode: Mode;
  blurb: string;
  /** Output fields. The first is the default when a target has no template. */
  fields: string[];
  auth?: AuthField[];
  dashboardUrl?: string;
  /** Page where the user creates the admin credential Molly asks for. Opened during login. */
  loginUrl?: string;
  /** Browser login via the platform's own CLI (e.g. `gh auth login`), when it's installed. */
  cliLogin?: CliLogin;
  /** Finds an existing login (e.g. `gh auth token`) so setup can skip asking. */
  autoAuth?(field: string): Promise<string | undefined>;
  /** Validates platform auth; returns a short account label. */
  checkAuth?(ctx: ProviderContext): Promise<string>;
  detect?(vars: Map<string, string>, file: string): Detection[];
  /** Fills credential params at setup. Returns questions it couldn't answer itself. */
  prepare?(ctx: ProviderContext, cred: CredentialSpec, current: Record<string, string>): Promise<Question[] | void>;
  /** Works out the provider id of the key currently in use, so it can be revoked. */
  resolveKeyId?(ctx: ProviderContext, cred: CredentialSpec, current: Record<string, string>): Promise<string | undefined>;
  issue?(ctx: ProviderContext, cred: CredentialSpec, currentKeyId?: string): Promise<Issued>;
  revoke?(ctx: ProviderContext, cred: CredentialSpec, keyId: string): Promise<void>;
  verify?(ctx: ProviderContext, cred: CredentialSpec, values: Record<string, string>): Promise<void>;
  guide?: Guide;
  /** Demo only: produces a realistic-looking fake value for a field. */
  sample?(field: string): string;
  /** Extra caveat shown in the plan, e.g. "logs every user out". */
  warning?: string;
}
