import type { Provider } from '../providers/types.js';
import { DriftError } from '../targets/remotes.js';
import { describeTarget } from '../targets/types.js';
import type { CredentialSpec, MollyConfig, TargetSpec } from './config.js';
import { providerContext, resolveAuth, type Runtime } from './runtime.js';
import { authKey, stashKey } from './store.js';
import { plainField, renderTemplate } from './util.js';

export interface RollOptions {
  only?: string[];
  keepOld?: boolean;
  force?: boolean;
  dryRun?: boolean;
}

export type Step = 'resolve' | 'issue' | 'prompt' | 'verify' | 'propagate' | 'revoke' | 'redeploy';

export type RollEvent =
  | { type: 'cred-start'; id: string }
  | { type: 'step'; id: string; step: Step; detail?: string }
  | { type: 'target'; id: string; index: number; status: 'ok' | 'error' | 'skipped'; message?: string }
  | {
      type: 'cred-done';
      id: string;
      status: 'rolled' | 'partial' | 'failed' | 'skipped';
      message?: string;
      followUps: string[];
    }
  | { type: 'redeploy'; project: string; status: 'ok' | 'error' | 'skipped'; message?: string };

export interface PromptRequest {
  cred: CredentialSpec;
  provider: Provider;
  field: string;
  url: string;
  steps: string[];
  pattern?: RegExp;
  /** Demo only: a fake value the user can drop in with tab. */
  sample?: string;
  /** Called with the pasted value; resolves with an error message to re-prompt, or undefined when accepted. */
  validate(value: string): Promise<string | undefined>;
}

export interface RollIO {
  emit(e: RollEvent): void;
  /** Asks the user for a value (guided platforms). Resolves null to skip the credential. */
  prompt(req: PromptRequest): Promise<string | null>;
}

interface Stash {
  keyId?: string;
  oldKeyId?: string;
  immediate?: boolean;
  values: Record<string, string>;
}

export interface PlanItem {
  cred: CredentialSpec;
  provider: Provider;
  problems: { index: number; message: string; drift: boolean }[];
  resuming: boolean;
}

export function selectCredentials(cfg: MollyConfig, only?: string[]): CredentialSpec[] {
  if (!only?.length) return cfg.credentials;
  return cfg.credentials.filter((c) => only.some((o) => c.id === o || c.platform === o || c.id.startsWith(o)));
}

/** Non-destructive checks: every target reachable, nothing edited behind Molly's back. */
export async function preflight(rt: Runtime, cfg: MollyConfig, opts: RollOptions = {}): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const cred of selectCredentials(cfg, opts.only)) {
    const provider = rt.registry[cred.platform];
    const problems: PlanItem['problems'] = [];
    await Promise.all(
      cred.targets.map(async (t, index) => {
        try {
          await rt.remotes.drivers[t.type].check(t);
        } catch (err: any) {
          problems.push({ index, message: err.message, drift: err instanceof DriftError });
        }
      }),
    );
    const resuming = !!(await rt.store.get(stashKey(cred.id)).catch(() => null));
    items.push({ cred, provider, problems: problems.sort((a, b) => a.index - b.index), resuming });
  }
  return items;
}

async function readCurrent(rt: Runtime, cred: CredentialSpec): Promise<Record<string, string>> {
  const current: Record<string, string> = {};
  for (const t of cred.targets) {
    const field = plainField(t.value ?? '');
    const read = rt.remotes.drivers[t.type].read;
    if (!field || current[field] || !read) continue;
    const v = await read(t).catch(() => undefined);
    if (v) current[field] = v;
  }
  return current;
}

function templateFor(t: TargetSpec, provider: Provider) {
  return t.value ?? `{{${provider.fields[0]}}}`;
}

export async function rollCredential(
  rt: Runtime,
  cfg: MollyConfig,
  cred: CredentialSpec,
  io: RollIO,
  opts: RollOptions,
  touchedVercel: Map<string, { projectId: string; teamId?: string; name: string }>,
  save: () => Promise<void>,
): Promise<void> {
  const provider = rt.registry[cred.platform];
  const ctx = providerContext(rt, provider, cred.params);
  const followUps: string[] = [];
  const done = (status: Extract<RollEvent, { type: 'cred-done' }>['status'], message?: string) =>
    io.emit({ type: 'cred-done', id: cred.id, status, message, followUps });

  io.emit({ type: 'cred-start', id: cred.id });
  if (!provider) return done('failed', `unknown platform "${cred.platform}"`);

  try {
    const current = await readCurrent(rt, cred);
    const rawStash = await rt.store.get(stashKey(cred.id)).catch(() => null);
    let stash: Stash | undefined = rawStash ? JSON.parse(rawStash) : undefined;

    if (!stash) {
      io.emit({ type: 'step', id: cred.id, step: 'resolve' });
      let oldKeyId = cred.state.keyId;
      if (!oldKeyId && provider.resolveKeyId) oldKeyId = await provider.resolveKeyId(ctx, cred, current).catch(() => undefined);

      if (provider.mode === 'guided') {
        const values: Record<string, string> = {};
        for (const field of provider.fields) {
          io.emit({ type: 'step', id: cred.id, step: 'prompt' });
          const value = await io.prompt({
            cred,
            provider,
            field,
            url: provider.guide!.url(cred, current),
            steps: provider.guide!.steps(cred, current),
            pattern: provider.guide!.pattern,
            sample: provider.sample?.(field),
            async validate(v) {
              if (provider.guide!.pattern && !provider.guide!.pattern.test(v)) return "That doesn't look like the right kind of key.";
              if (current[field] && v === current[field]) return "That's the old key. Paste the new one.";
              if (provider.verify) {
                try {
                  await provider.verify(ctx, cred, { ...values, [field]: v });
                } catch (err: any) {
                  return `That key didn't work: ${err.message}`;
                }
              }
              return undefined;
            },
          });
          if (value === null) return done('skipped', 'skipped by you');
          values[field] = value;
        }
        stash = { values, oldKeyId };
      } else {
        io.emit({ type: 'step', id: cred.id, step: 'issue' });
        const issued = await provider.issue!(ctx, cred, oldKeyId);
        stash = { ...issued, oldKeyId };
      }
      // Persist before touching anything, so the new key can never be lost mid-roll.
      await rt.store.set(stashKey(cred.id), JSON.stringify(stash));

      if (provider.mode !== 'guided' && provider.verify) {
        io.emit({ type: 'step', id: cred.id, step: 'verify' });
        await provider.verify(ctx, cred, stash.values);
      }
    }

    io.emit({ type: 'step', id: cred.id, step: 'propagate' });
    let failures = 0;
    for (const [index, t] of cred.targets.entries()) {
      try {
        const driver = rt.remotes.drivers[t.type];
        if (!opts.force) await driver.check(t);
        await driver.write(t, renderTemplate(templateFor(t, provider), stash.values));
        if (t.type === 'vercel') touchedVercel.set(t.projectId!, { projectId: t.projectId!, teamId: t.teamId, name: t.repo ?? t.projectId! });
        io.emit({ type: 'target', id: cred.id, index, status: 'ok' });
      } catch (err: any) {
        failures++;
        const message = err instanceof DriftError ? `${err.message} (use --force to overwrite)` : err.message;
        io.emit({ type: 'target', id: cred.id, index, status: 'error', message });
      }
    }
    await save();

    if (failures) {
      const why = stash.immediate
        ? 'The old value is already invalid, so the targets that failed are broken until you finish.'
        : 'Your old key still works, so nothing is broken.';
      return done(
        'partial',
        `${failures} of ${cred.targets.length} targets failed. ${why} The new key is saved in your keychain: fix the issue and run \`molly roll --only ${cred.id}\` to finish.`,
      );
    }

    const oldKeyId = stash.oldKeyId;
    if (!stash.immediate) {
      if (oldKeyId && oldKeyId !== stash.keyId && provider.revoke) {
        if (opts.keepOld) {
          cred.state.pendingRevoke = [...(cred.state.pendingRevoke ?? []), { keyId: oldKeyId, since: new Date().toISOString() }];
          followUps.push('Old key kept alive (--keep-old). Run `molly finalize` to revoke it.');
        } else {
          io.emit({ type: 'step', id: cred.id, step: 'revoke' });
          try {
            await provider.revoke(ctx, cred, oldKeyId);
          } catch (err: any) {
            followUps.push(`Couldn't revoke the old key (${err.message}). Revoke it at ${provider.dashboardUrl}`);
          }
        }
      } else if (provider.guide?.afterwards) {
        followUps.push(provider.guide.afterwards);
      } else if (!oldKeyId && provider.dashboardUrl) {
        followUps.push(`First roll: Molly didn't create the old key, so revoke it yourself at ${provider.dashboardUrl}`);
      }
    }

    await syncPlatformAuth(rt, provider, current, stash.values);
    cred.state.keyId = stash.keyId ?? cred.state.keyId;
    cred.state.rotatedAt = new Date().toISOString();
    await save();
    await rt.store.delete(stashKey(cred.id)).catch(() => {});
    done('rolled');
  } catch (err: any) {
    await save().catch(() => {});
    done('failed', err.message);
  }
}

/** If the key just rolled is also the one Molly uses to talk to that platform, keep the keychain copy current. */
async function syncPlatformAuth(rt: Runtime, provider: Provider, oldValues: Record<string, string>, newValues: Record<string, string>) {
  for (const a of provider.auth ?? []) {
    const stored = await rt.store.get(authKey(provider.id, a.key)).catch(() => null);
    if (!stored) continue;
    for (const [field, old] of Object.entries(oldValues)) {
      if (old === stored && newValues[field]) await rt.store.set(authKey(provider.id, a.key), newValues[field]);
    }
  }
}

export async function rollAll(rt: Runtime, cfg: MollyConfig, io: RollIO, opts: RollOptions, save: () => Promise<void>) {
  const touched = new Map<string, { projectId: string; teamId?: string; name: string }>();
  for (const cred of selectCredentials(cfg, opts.only)) {
    await rollCredential(rt, cfg, cred, io, opts, touched, save);
  }
  if (cfg.options.redeployVercel) {
    for (const p of touched.values()) {
      try {
        const url = await rt.remotes.vercelRedeploy(p.projectId, p.teamId);
        io.emit({ type: 'redeploy', project: p.name, status: 'ok', message: url });
      } catch (err: any) {
        io.emit({ type: 'redeploy', project: p.name, status: 'error', message: err.message });
      }
    }
  } else if (touched.size) {
    io.emit({
      type: 'redeploy',
      project: [...touched.values()].map((p) => p.name).join(', '),
      status: 'skipped',
      message: 'Vercel env updated. Redeploy to pick up new values (or enable auto-redeploy in `molly setup`).',
    });
  }
}

/** Revokes old keys kept alive with --keep-old. */
export async function finalize(rt: Runtime, cfg: MollyConfig, log: (msg: string) => void) {
  for (const cred of cfg.credentials) {
    const provider = rt.registry[cred.platform];
    const pending = cred.state.pendingRevoke ?? [];
    const remaining: typeof pending = [];
    for (const p of pending) {
      try {
        await provider.revoke!(providerContext(rt, provider, cred.params), cred, p.keyId);
        log(`✓ ${cred.label}: revoked ${p.keyId}`);
      } catch (err: any) {
        remaining.push(p);
        log(`✗ ${cred.label}: ${err.message}`);
      }
    }
    cred.state.pendingRevoke = remaining.length ? remaining : undefined;
  }
}

export { describeTarget, resolveAuth };
