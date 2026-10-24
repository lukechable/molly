import type { CredentialSpec, MollyConfig } from './config.js';
import type { Draft } from './discover.js';

const sameCredential = (a: CredentialSpec, b: CredentialSpec) =>
  a.platform === b.platform &&
  a.targets.some((t) => t.type === 'dotenv' && b.targets.some((u) => u.type === 'dotenv' && u.path === t.path && u.key === t.key));

/** Carries ids, rotation state and answered params over from a previous setup. */
export function adoptExisting(drafts: Draft[], existing: MollyConfig | null): void {
  if (!existing) return;
  for (const d of drafts) {
    const old = existing.credentials.find((c) => sameCredential(c, d.cred));
    if (!old) continue;
    d.cred.id = old.id;
    d.cred.state = old.state;
    d.cred.params = { ...d.cred.params, ...old.params };
  }
}

export function mergeConfig(
  existing: MollyConfig | null,
  next: Pick<MollyConfig, 'platforms' | 'roots' | 'options'>,
  creds: CredentialSpec[],
): MollyConfig {
  const kept = (existing?.credentials ?? []).filter(
    (old) => next.platforms.includes(old.platform) && !creds.some((c) => c.id === old.id || sameCredential(c, old)),
  );
  return { version: 1, ...next, credentials: [...creds, ...kept] };
}
