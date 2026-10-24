import { bearer, request } from '../core/util.js';
import { simpleDetector, stamp } from './common.js';
import type { Provider, ProviderContext } from './types.js';

const API = 'https://api.openai.com/v1';

async function admin(ctx: ProviderContext, path: string, opts: Parameters<typeof request>[1] = {}) {
  return request(`${API}${path}`, { ...opts, headers: { ...bearer(await ctx.auth('admin_key')), ...opts.headers } });
}

async function listAll(ctx: ProviderContext, path: string): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await admin(ctx, `${path}${sep}limit=100${after ? `&after=${after}` : ''}`);
    out.push(...res.data);
    if (!res.has_more) break;
    after = res.last_id ?? res.data.at(-1)?.id;
  }
  return out;
}

/** redacted_value looks like "sk-abc...xyz". */
function matchesRedacted(redacted: string | undefined, value: string): boolean {
  if (!redacted) return false;
  const [pre, suf] = redacted.split(/\*+|\.\.\.|…/);
  return !!pre && !!suf && value.startsWith(pre) && value.endsWith(suf);
}

async function findKey(ctx: ProviderContext, value: string, projectIds: string[]) {
  for (const project of projectIds) {
    const keys = await listAll(ctx, `/organization/projects/${project}/api_keys?owner_project_access=any`);
    const hit = keys.filter((k) => matchesRedacted(k.redacted_value, value));
    if (hit.length === 1) {
      const k = hit[0];
      const keyId = k.owner?.type === 'service_account' ? `svc:${k.owner.service_account?.id}` : `key:${k.id}`;
      return { project, keyId };
    }
  }
  return undefined;
}

export const openai: Provider = {
  id: 'openai',
  name: 'OpenAI',
  category: 'ai',
  mode: 'auto',
  blurb: 'Issues a fresh project service-account key, deletes the old one',
  fields: ['secret'],
  dashboardUrl: 'https://platform.openai.com/api-keys',
  loginUrl: 'https://platform.openai.com/settings/organization/admin-keys',
  auth: [
    {
      key: 'admin_key',
      label: 'Admin API key',
      secret: true,
      help: 'platform.openai.com/settings/organization/admin-keys (starts with sk-admin-)',
    },
  ],
  async checkAuth(ctx) {
    const res = await admin(ctx, '/organization/projects?limit=100');
    return `${res.data.length} project${res.data.length === 1 ? '' : 's'}`;
  },
  detect: simpleDetector('openai', 'secret', {
    names: /OPENAI_(API_)?KEY$/,
    shape: /^sk-(?!ant-|admin-)/,
    prefix: /^sk-(proj|svcacct)-[\w-]{20,}$/,
  }),
  async prepare(ctx, cred, current) {
    if (cred.params.project_id) return;
    const projects = (await listAll(ctx, '/organization/projects')).filter((p) => p.status !== 'archived');
    const found = current.secret && (await findKey(ctx, current.secret, projects.map((p) => p.id)));
    if (found) {
      cred.params.project_id = found.project;
      cred.state.keyId = found.keyId;
      return;
    }
    if (projects.length === 1) {
      cred.params.project_id = projects[0].id;
      return;
    }
    return [
      {
        param: 'project_id',
        prompt: `Which OpenAI project should ${cred.label} belong to?`,
        options: projects.map((p) => ({ label: p.name, value: p.id })),
      },
    ];
  },
  async resolveKeyId(ctx, cred, current) {
    if (!current.secret || !cred.params.project_id) return undefined;
    return (await findKey(ctx, current.secret, [cred.params.project_id]))?.keyId;
  },
  async issue(ctx, cred) {
    const project = cred.params.project_id;
    if (!project) throw new Error('no OpenAI project configured; re-run `molly setup`');
    const res = await admin(ctx, `/organization/projects/${project}/service_accounts`, {
      json: { name: `molly ${cred.label} ${stamp()}` },
    });
    return { keyId: `svc:${res.id}`, values: { secret: res.api_key.value } };
  },
  async revoke(ctx, cred, keyId) {
    const project = cred.params.project_id;
    const [kind, id] = keyId.split(':');
    const path = kind === 'svc' ? 'service_accounts' : 'api_keys';
    await admin(ctx, `/organization/projects/${project}/${path}/${id}`, { method: 'DELETE', allow: [404] });
  },
  async verify(_ctx, _cred, values) {
    await request(`${API}/models?limit=1`, { headers: bearer(values.secret) });
  },
};
