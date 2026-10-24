import { bearer, request } from '../core/util.js';
import { simpleDetector } from './common.js';
import type { Provider } from './types.js';

const API = 'https://api.cloudflare.com/client/v4';

async function verifyToken(token: string): Promise<string> {
  const res = await request(`${API}/user/tokens/verify`, { headers: bearer(token) });
  return res.result.id;
}

export const cloudflare: Provider = {
  id: 'cloudflare',
  name: 'Cloudflare',
  category: 'cloud',
  mode: 'auto',
  blurb: 'Rolls API tokens in place (same permissions, new value)',
  fields: ['secret'],
  dashboardUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  loginUrl: 'https://dash.cloudflare.com/profile/api-tokens',
  auth: [
    {
      key: 'api_token',
      label: 'API token with "API Tokens: Edit" permission',
      secret: true,
      help: 'dash.cloudflare.com/profile/api-tokens → Create Token → "Create additional tokens" template',
    },
  ],
  async checkAuth(ctx) {
    await verifyToken(await ctx.auth('api_token'));
    return 'token valid';
  },
  detect: simpleDetector('cloudflare', 'secret', { names: /^(CLOUDFLARE|CF)_API_TOKEN$/ }),
  async prepare(_ctx, cred, current) {
    if (cred.state.keyId) return;
    cred.state.keyId = await verifyToken(current.secret);
  },
  async resolveKeyId(_ctx, _cred, current) {
    return current.secret ? verifyToken(current.secret) : undefined;
  },
  async issue(ctx, _cred, currentKeyId) {
    if (!currentKeyId) throw new Error('could not identify the current token; re-run `molly setup`');
    const res = await request(`${API}/user/tokens/${currentKeyId}/value`, {
      method: 'PUT',
      json: {},
      headers: bearer(await ctx.auth('api_token')),
    });
    return { keyId: currentKeyId, values: { secret: res.result }, immediate: true };
  },
  async verify(_ctx, _cred, values) {
    await verifyToken(values.secret);
  },
};
