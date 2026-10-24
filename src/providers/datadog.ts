import { request } from '../core/util.js';
import { simpleDetector, stamp } from './common.js';
import type { Provider, ProviderContext } from './types.js';

async function dd(ctx: ProviderContext, path: string, opts: Parameters<typeof request>[1] = {}) {
  const site = (await ctx.authOptional('site')) || 'datadoghq.com';
  return request(`https://api.${site}${path}`, {
    ...opts,
    headers: { 'DD-API-KEY': await ctx.auth('api_key'), 'DD-APPLICATION-KEY': await ctx.auth('app_key') },
  });
}

export const datadog: Provider = {
  id: 'datadog',
  name: 'Datadog',
  category: 'observability',
  mode: 'auto',
  blurb: 'Creates a new API key, deletes the old one',
  fields: ['secret'],
  dashboardUrl: 'https://app.datadoghq.com/organization-settings/api-keys',
  loginUrl: 'https://app.datadoghq.com/organization-settings/application-keys',
  auth: [
    { key: 'api_key', label: 'API key', secret: true },
    { key: 'app_key', label: 'Application key (api_keys_write scope)', secret: true },
    { key: 'site', label: 'Site', secret: false, optional: true, default: 'datadoghq.com', help: 'e.g. datadoghq.eu, us5.datadoghq.com' },
  ],
  async checkAuth(ctx) {
    await dd(ctx, '/api/v2/api_keys?page[size]=1');
    return 'connected';
  },
  detect: simpleDetector('datadog', 'secret', { names: /^(DD|DATADOG)_API_KEY$/, shape: /^[0-9a-f]{32}$/ }),
  async resolveKeyId(ctx, _cred, current) {
    if (!current.secret) return undefined;
    const res = await dd(ctx, '/api/v2/api_keys?page[size]=100');
    const hits = res.data.filter((k: any) => k.attributes.last4 === current.secret.slice(-4));
    return hits.length === 1 ? hits[0].id : undefined;
  },
  async issue(ctx, cred) {
    const res = await dd(ctx, '/api/v2/api_keys', {
      json: { data: { type: 'api_keys', attributes: { name: `molly ${cred.label} ${stamp()}` } } },
    });
    return { keyId: res.data.id, values: { secret: res.data.attributes.key } };
  },
  async revoke(ctx, _cred, keyId) {
    await dd(ctx, `/api/v2/api_keys/${keyId}`, { method: 'DELETE', allow: [404] });
  },
  async verify(ctx, _cred, values) {
    const site = (await ctx.authOptional('site')) || 'datadoghq.com';
    await request(`https://api.${site}/api/v1/validate`, { headers: { 'DD-API-KEY': values.secret } });
  },
};
