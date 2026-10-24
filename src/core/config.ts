import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

/** Where a credential's value lives. One credential usually has many targets. */
export interface TargetSpec {
  type: 'dotenv' | 'github' | 'vercel';
  /** Variable name at the target, e.g. OPENAI_API_KEY. */
  key: string;
  /** Value template. Defaults to `{{<first provider field>}}`. */
  value?: string;
  /** Repo this target belongs to (local path for dotenv, owner/name for github, project name for vercel). */
  repo?: string;
  // dotenv
  path?: string;
  /** Short sha256 of the value Molly last saw/wrote, used to detect out-of-band edits. */
  fingerprint?: string;
  // github
  slug?: string;
  environment?: string;
  // vercel
  projectId?: string;
  teamId?: string;
  envIds?: string[];
}

export interface CredentialState {
  /** Provider-side id of the key currently in use (when Molly knows it). */
  keyId?: string;
  rotatedAt?: string;
  /** Old keys kept alive with `--keep-old`, revoked later by `molly finalize`. */
  pendingRevoke?: { keyId: string; since: string }[];
}

export interface CredentialSpec {
  id: string;
  platform: string;
  label: string;
  params: Record<string, string>;
  targets: TargetSpec[];
  state: CredentialState;
}

export interface MollyConfig {
  version: 1;
  platforms: string[];
  roots: string[];
  options: { redeployVercel: boolean };
  credentials: CredentialSpec[];
}

export function mollyHome(): string {
  if (process.env.MOLLY_HOME) return process.env.MOLLY_HOME;
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'molly');
}

export function configPath(): string {
  return path.join(mollyHome(), 'molly.yaml');
}

export function emptyConfig(): MollyConfig {
  return { version: 1, platforms: [], roots: [], options: { redeployVercel: false }, credentials: [] };
}

export async function loadConfig(): Promise<MollyConfig | null> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = YAML.parse(raw) as MollyConfig;
    return { ...emptyConfig(), ...parsed, options: { ...emptyConfig().options, ...parsed.options } };
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function saveConfig(cfg: MollyConfig): Promise<void> {
  const file = configPath();
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const header = '# Molly config. Contains no secret values: those live in your OS keychain.\n';
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, header + YAML.stringify(cfg), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function tildify(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}
