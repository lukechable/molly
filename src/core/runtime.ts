import { liveRegistry, type Registry } from '../providers/index.js';
import type { Provider, ProviderContext } from '../providers/types.js';
import { liveRemotes } from '../targets/remotes.js';
import type { Remotes } from '../targets/types.js';
import { authKey, envNameFor, KeychainStore, type SecretStore } from './store.js';

/** Everything Molly talks to. The demo swaps in fakes; tests swap in mocks. */
export interface Runtime {
  registry: Registry;
  store: SecretStore;
  remotes: Remotes;
  demo?: boolean;
}

export function liveRuntime(): Runtime {
  const rt: Runtime = { registry: liveRegistry(), store: new KeychainStore(), remotes: undefined as any };
  rt.remotes = liveRemotes(async (platform) => {
    const token = await resolveAuth(rt, platform, 'token');
    if (!token) throw new Error(`${rt.registry[platform].name} isn't connected. Run \`molly setup\`.`);
    return token;
  });
  return rt;
}

export type AuthSource = 'env' | 'keychain' | 'auto' | 'default';

/** Auth lookup order: MOLLY_<PLATFORM>_<FIELD> env var → keychain → auto-detected login → default. */
export async function resolveAuthWithSource(
  rt: Runtime,
  platform: string,
  field: string,
): Promise<{ value: string; source: AuthSource } | undefined> {
  const env = process.env[envNameFor(authKey(platform, field))];
  if (env) return { value: env, source: 'env' };
  const stored = await rt.store.get(authKey(platform, field)).catch(() => null);
  if (stored) return { value: stored, source: 'keychain' };
  const provider = rt.registry[platform];
  const auto = await provider?.autoAuth?.(field);
  if (auto) return { value: auto, source: 'auto' };
  const def = provider?.auth?.find((a) => a.key === field)?.default;
  if (def) return { value: def, source: 'default' };
  return undefined;
}

export async function resolveAuth(rt: Runtime, platform: string, field: string) {
  return (await resolveAuthWithSource(rt, platform, field))?.value;
}

export function providerContext(rt: Runtime, provider: Provider, params: Record<string, string> = {}): ProviderContext {
  return {
    params,
    async authOptional(field) {
      return resolveAuth(rt, provider.id, field);
    },
    async auth(field) {
      const v = await resolveAuth(rt, provider.id, field);
      if (!v) {
        const label = provider.auth?.find((a) => a.key === field)?.label ?? field;
        throw new Error(`${provider.name} isn't connected (missing ${label}). Run \`molly setup\`.`);
      }
      return v;
    },
  };
}
