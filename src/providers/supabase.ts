import { bearer, fingerprint, request } from '../core/util.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliLogin } from './cli.js';
import { isPlaceholder, stamp } from './common.js';
import type { Detection, Provider, ProviderContext } from './types.js';

const API = 'https://api.supabase.com/v1';

async function sb(ctx: ProviderContext, path: string, opts: Parameters<typeof request>[1] = {}) {
  return request(`${API}${path}`, { ...opts, headers: bearer(await ctx.auth('access_token')) });
}

const KEY_NAMES = /SUPABASE_(SERVICE_ROLE_KEY|SECRET_KEY|SECRET)$/;

export const supabase: Provider = {
  id: 'supabase',
  name: 'Supabase',
  category: 'database',
  mode: 'auto',
  blurb: 'Creates a new secret API key (sb_secret_…), deletes the old one',
  fields: ['secret'],
  dashboardUrl: 'https://supabase.com/dashboard/project/_/settings/api-keys',
  loginUrl: 'https://supabase.com/dashboard/account/tokens',
  cliLogin: cliLogin('Supabase CLI', 'supabase', ['login']),
  async autoAuth() {
    if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
    try {
      return (await fs.readFile(path.join(os.homedir(), '.supabase', 'access-token'), 'utf8')).trim() || undefined;
    } catch {
      return undefined;
    }
  },
  auth: [
    {
      key: 'access_token',
      label: 'Personal access token',
      secret: true,
      help: 'supabase.com/dashboard/account/tokens',
    },
  ],
  async checkAuth(ctx) {
    const projects = await sb(ctx, '/projects');
    return `${projects.length} project${projects.length === 1 ? '' : 's'}`;
  },
  detect(vars) {
    const url = [...vars].find(([k]) => /SUPABASE_URL$/.test(k))?.[1];
    const ref = url && /^https:\/\/([a-z0-9]{20})\.supabase\.co/.exec(url)?.[1];
    if (!ref) return [];
    const out: Detection[] = [];
    for (const [key, value] of vars) {
      if (!KEY_NAMES.test(key) || isPlaceholder(value)) continue;
      out.push({
        provider: 'supabase',
        identity: `supabase:${fingerprint(value)}`,
        field: 'secret',
        key,
        label: `${key} (${ref})`,
        params: { ref, legacy: value.startsWith('eyJ') ? 'true' : 'false' },
        current: value,
      });
    }
    return out;
  },
  async resolveKeyId(ctx, cred, current) {
    if (!current.secret?.startsWith('sb_secret_')) return undefined;
    const keys = await sb(ctx, `/projects/${cred.params.ref}/api-keys?reveal=true`);
    return keys.find((k: any) => k.api_key === current.secret)?.id;
  },
  async issue(ctx, cred) {
    const res = await sb(ctx, `/projects/${cred.params.ref}/api-keys?reveal=true`, {
      json: { type: 'secret', name: `molly_${stamp().replace(/-/g, '')}_${Date.now() % 100000}` },
    });
    if (!res.api_key) throw new Error('Supabase did not reveal the new key');
    cred.params.legacy = 'false';
    return { keyId: res.id, values: { secret: res.api_key } };
  },
  async revoke(ctx, cred, keyId) {
    await sb(ctx, `/projects/${cred.params.ref}/api-keys/${keyId}?reason=rotating_key`, { method: 'DELETE', allow: [404] });
  },
};
