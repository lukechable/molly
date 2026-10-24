import { bearer, request, sleep } from '../core/util.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cliLogin } from './cli.js';
import { isPlaceholder } from './common.js';
import type { Detection, Provider, ProviderContext } from './types.js';

const API = 'https://console.neon.tech/api/v2';

async function neon(ctx: ProviderContext, path: string, opts: Parameters<typeof request>[1] = {}) {
  return request(`${API}${path}`, { ...opts, headers: bearer(await ctx.auth('api_key')) });
}

/** Turns a Neon connection string into a template with the password swapped for a placeholder. */
export function neonTemplate(raw: string): { template: string; password: string; endpoint: string; role: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (!/^postgres(ql)?:$/.test(url.protocol) || !url.hostname.endsWith('.neon.tech') || !url.password) return undefined;
  const password = decodeURIComponent(url.password);
  const endpoint = url.hostname.split('.')[0].replace(/-pooler$/, '');
  const role = decodeURIComponent(url.username);
  const marker = 'MOLLYPASSWORDMARKER';
  url.password = marker;
  return { template: url.toString().replace(marker, '{{password:url}}'), password, endpoint, role };
}

export const neonProvider: Provider = {
  id: 'neon',
  name: 'Neon Postgres',
  category: 'database',
  mode: 'auto',
  blurb: 'Resets database role passwords and rewrites every DATABASE_URL',
  fields: ['password'],
  dashboardUrl: 'https://console.neon.tech',
  loginUrl: 'https://console.neon.tech/app/settings/api-keys',
  warning: 'Open connections using the old password are dropped.',
  cliLogin: cliLogin('Neon CLI', 'neonctl', ['auth']),
  async autoAuth() {
    try {
      const file = path.join(os.homedir(), '.config', 'neonctl', 'credentials.json');
      return JSON.parse(await fs.readFile(file, 'utf8')).access_token || undefined;
    } catch {
      return undefined;
    }
  },
  auth: [{ key: 'api_key', label: 'Neon API key', secret: true, help: 'console.neon.tech/app/settings/api-keys' }],
  async checkAuth(ctx) {
    const res = await neon(ctx, '/projects?limit=1');
    return res.projects?.length ? 'connected' : 'no projects visible';
  },
  detect(vars) {
    const out: Detection[] = [];
    for (const [key, value] of vars) {
      if (isPlaceholder(value)) continue;
      const t = neonTemplate(value);
      if (!t) continue;
      out.push({
        provider: 'neon',
        identity: `neon:${t.role}@${t.endpoint}`,
        field: 'password',
        key,
        template: t.template,
        label: `${t.role}@${t.endpoint}`,
        params: { endpoint: t.endpoint, role: t.role },
        current: t.password,
      });
    }
    return out;
  },
  async prepare(ctx, cred) {
    if (cred.params.project_id) return;
    for (const p of await allProjects(ctx)) {
      const { endpoints } = await neon(ctx, `/projects/${p.id}/endpoints`);
      const ep = endpoints.find((e: any) => e.id === cred.params.endpoint);
      if (ep) {
        cred.params.project_id = p.id;
        cred.params.branch_id = ep.branch_id;
        cred.label = `${cred.params.role} @ ${p.name}`;
        return;
      }
    }
    throw new Error(`endpoint ${cred.params.endpoint} not found in your Neon account`);
  },
  async issue(ctx, cred) {
    const { project_id, branch_id, role } = cred.params;
    const res = await neon(
      ctx,
      `/projects/${project_id}/branches/${branch_id}/roles/${encodeURIComponent(role)}/reset_password`,
      { method: 'POST' },
    );
    // The new password only works once Neon finishes applying it.
    for (const op of res.operations ?? []) await waitForOperation(ctx, project_id, op.id);
    return { values: { password: res.role.password }, immediate: true };
  },
};

/** Personal API keys only list personal projects without `org_id`, so walk every org too. */
async function allProjects(ctx: ProviderContext): Promise<any[]> {
  const seen = new Map<string, any>();
  const scopes = [''];
  try {
    const orgs = await neon(ctx, '/users/me/organizations');
    for (const o of orgs.organizations ?? []) scopes.push(`&org_id=${o.id}`);
  } catch {}
  for (const scope of scopes) {
    try {
      const { projects } = await neon(ctx, `/projects?limit=400${scope}`);
      for (const p of projects ?? []) seen.set(p.id, p);
    } catch {}
  }
  return [...seen.values()];
}

async function waitForOperation(ctx: ProviderContext, projectId: string, opId: string) {
  for (let i = 0; i < 60; i++) {
    const { operation } = await neon(ctx, `/projects/${projectId}/operations/${opId}`);
    if (operation.status === 'finished') return;
    if (operation.status === 'failed' || operation.status === 'error') throw new Error(`Neon operation ${opId} failed`);
    await sleep(1000);
  }
  throw new Error('timed out waiting for Neon to apply the new password');
}
