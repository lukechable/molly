import path from 'node:path';
import type { TargetSpec } from '../core/config.js';

export interface TargetDriver {
  /** Throws if the target can't be written (missing file, no access, variable gone). */
  check(t: TargetSpec): Promise<void>;
  /** Current value, for targets that can be read back (local files only). */
  read?(t: TargetSpec): Promise<string | undefined>;
  write(t: TargetSpec, value: string): Promise<void>;
}

export interface VercelEnv {
  id: string;
  key: string;
  type: string;
  target: string[];
  /** Present only when Vercel can decrypt it for us. */
  value?: string;
}

/** Remote lookups used by discovery and post-roll actions. Swappable for the demo. */
export interface Remotes {
  drivers: Record<TargetSpec['type'], TargetDriver>;
  githubSecrets(slug: string): Promise<{ repo: string[]; environments: Record<string, string[]> }>;
  vercelEnv(projectId: string, teamId?: string): Promise<VercelEnv[]>;
  vercelRedeploy(projectId: string, teamId?: string): Promise<string>;
}

export function describeTarget(t: TargetSpec): string {
  switch (t.type) {
    case 'dotenv':
      // "acme-api/.env" reads better than an absolute path.
      return t.repo ? path.relative(path.dirname(t.repo), t.path!) : t.path!;
    case 'github':
      return `GitHub ${t.slug}${t.environment ? ` (${t.environment})` : ''} · Actions secret`;
    case 'vercel':
      return `Vercel ${t.repo ?? t.projectId}`;
  }
}
