import { basic, bearer, request } from '../core/util.js';
import { pairedDetector, simpleDetector, stamp } from './common.js';
import type { Provider, ProviderContext } from './types.js';

export const resend: Provider = {
  id: 'resend',
  name: 'Resend',
  category: 'email',
  mode: 'auto',
  blurb: 'Creates a new API key, deletes the old one',
  fields: ['secret'],
  dashboardUrl: 'https://resend.com/api-keys',
  loginUrl: 'https://resend.com/api-keys',
  auth: [{ key: 'api_key', label: 'Full-access API key', secret: true, help: 'resend.com/api-keys' }],
  async checkAuth(ctx) {
    const res = await request('https://api.resend.com/api-keys', { headers: bearer(await ctx.auth('api_key')) });
    return `${res.data?.length ?? 0} keys`;
  },
  detect: simpleDetector('resend', 'secret', { names: /RESEND_(API_)?KEY$/, prefix: /^re_[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}$/ }),
  async issue(ctx, cred) {
    const res = await request('https://api.resend.com/api-keys', {
      headers: bearer(await ctx.auth('api_key')),
      json: {
        name: `molly ${cred.label} ${stamp()}`,
        permission: cred.params.permission ?? 'full_access',
        ...(cred.params.domain_id ? { domain_id: cred.params.domain_id } : {}),
      },
    });
    return { keyId: res.id, values: { secret: res.token } };
  },
  async revoke(ctx, _cred, keyId) {
    await request(`https://api.resend.com/api-keys/${keyId}`, {
      method: 'DELETE',
      headers: bearer(await ctx.auth('api_key')),
      allow: [404],
    });
  },
};

const SG = 'https://api.sendgrid.com/v3';

export const sendgrid: Provider = {
  id: 'sendgrid',
  name: 'SendGrid',
  category: 'email',
  mode: 'auto',
  blurb: 'Creates a new API key with the same scopes, deletes the old one',
  fields: ['secret'],
  dashboardUrl: 'https://app.sendgrid.com/settings/api_keys',
  loginUrl: 'https://app.sendgrid.com/settings/api_keys',
  auth: [{ key: 'api_key', label: 'API key with "API Keys" full access', secret: true }],
  async checkAuth(ctx) {
    const res = await request(`${SG}/scopes`, { headers: bearer(await ctx.auth('api_key')) });
    return `${res.scopes.length} scopes`;
  },
  detect: simpleDetector('sendgrid', 'secret', { names: /SENDGRID_API_KEY$/, prefix: /^SG\.[\w-]{16,}\.[\w-]{16,}$/ }),
  async issue(ctx, cred, currentKeyId) {
    const headers = bearer(await ctx.auth('api_key'));
    // Keep the old key's scopes when Molly knows it; otherwise inherit the admin key's.
    let scopes: string[] | undefined;
    if (currentKeyId) {
      const res = await request(`${SG}/api_keys/${currentKeyId}`, { headers });
      scopes = res.result?.[0]?.scopes ?? res.scopes;
    }
    scopes ??= (await request(`${SG}/scopes`, { headers })).scopes;
    const res = await request(`${SG}/api_keys`, { headers, json: { name: `molly ${cred.label} ${stamp()}`, scopes } });
    return { keyId: res.api_key_id, values: { secret: res.api_key } };
  },
  async revoke(ctx, _cred, keyId) {
    await request(`${SG}/api_keys/${keyId}`, { method: 'DELETE', headers: bearer(await ctx.auth('api_key')), allow: [404] });
  },
  async verify(_ctx, _cred, values) {
    await request(`${SG}/scopes`, { headers: bearer(values.secret) });
  },
};

const TW = 'https://api.twilio.com/2010-04-01';

async function twilio(ctx: ProviderContext, path: string, opts: Parameters<typeof request>[1] = {}) {
  const sid = await ctx.auth('account_sid');
  return request(`${TW}/Accounts/${sid}${path}`, { ...opts, headers: basic(sid, await ctx.auth('auth_token')) });
}

export const twilio_: Provider = {
  id: 'twilio',
  name: 'Twilio',
  category: 'email',
  mode: 'auto',
  blurb: 'Creates a new API key + secret pair, deletes the old one',
  fields: ['sid', 'secret'],
  dashboardUrl: 'https://console.twilio.com/us1/account/keys-credentials/api-keys',
  loginUrl: 'https://console.twilio.com',
  auth: [
    { key: 'account_sid', label: 'Account SID', secret: false },
    { key: 'auth_token', label: 'Auth token', secret: true },
  ],
  async checkAuth(ctx) {
    const res = await twilio(ctx, '.json');
    return res.friendly_name ?? 'connected';
  },
  detect: pairedDetector('twilio', 'sid', 'secret', /^SK[0-9a-f]{32}$/, /TWILIO_API_KEY(_SID)?$/, (k) => [
    k.replace(/_KEY(_SID)?$/, '_SECRET'),
    k.replace(/_KEY(_SID)?$/, '_KEY_SECRET'),
  ]),
  async resolveKeyId(_ctx, _cred, current) {
    return current.sid;
  },
  async issue(ctx, cred) {
    const res = await twilio(ctx, '/Keys.json', { form: { FriendlyName: `molly ${cred.label} ${stamp()}` } });
    return { keyId: res.sid, values: { sid: res.sid, secret: res.secret } };
  },
  async revoke(ctx, _cred, keyId) {
    await twilio(ctx, `/Keys/${keyId}.json`, { method: 'DELETE', allow: [404] });
  },
  async verify(ctx, _cred, values) {
    const sid = await ctx.auth('account_sid');
    await request(`${TW}/Accounts/${sid}.json`, { headers: basic(values.sid, values.secret) });
  },
};
