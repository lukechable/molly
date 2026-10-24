import { bearer, basic, request } from '../core/util.js';
import { simpleDetector } from './common.js';
import type { Provider } from './types.js';

const last4 = (v?: string) => (v ? `…${v.slice(-4)}` : 'your current key');

export const stripe: Provider = {
  id: 'stripe',
  name: 'Stripe',
  category: 'payments',
  mode: 'guided',
  blurb: 'Stripe has no key API: you click "Roll key", Molly does everything else',
  fields: ['secret'],
  dashboardUrl: 'https://dashboard.stripe.com/apikeys',
  detect: simpleDetector('stripe', 'secret', {
    names: /STRIPE_(SECRET|API|RESTRICTED)_KEY$/,
    shape: /^(sk|rk)_(live|test)_/,
    prefix: /^(sk|rk)_live_[A-Za-z0-9]{20,}$/,
    exclude: /CLERK/,
  }),
  guide: {
    url: (_c, cur) => `https://dashboard.stripe.com/${cur.secret?.includes('_test_') ? 'test/' : ''}apikeys`,
    steps: (_c, cur) => [
      `Find the key ending in ${last4(cur.secret)}`,
      'Click ⋯ → Roll key. Pick an expiry for the old key (1 hour is plenty: Molly updates everything now)',
      'Copy the new key and paste it below',
    ],
    pattern: /^(sk|rk)_(live|test)_[A-Za-z0-9]{20,}$/,
    afterwards: 'Stripe expires the old key on the schedule you picked.',
  },
  async verify(_ctx, _cred, values) {
    // Restricted keys may lack balance access: 403 still proves the key authenticates.
    await request('https://api.stripe.com/v1/balance', { headers: basic(values.secret, ''), allow: [403] });
  },
};

export const anthropic: Provider = {
  id: 'anthropic',
  name: 'Anthropic',
  category: 'ai',
  mode: 'guided',
  blurb: 'You create the key in the Console, Molly verifies it and updates every repo',
  fields: ['secret'],
  dashboardUrl: 'https://console.anthropic.com/settings/keys',
  loginUrl: 'https://console.anthropic.com/settings/admin-keys',
  detect: simpleDetector('anthropic', 'secret', { names: /ANTHROPIC_API_KEY$|CLAUDE_API_KEY$/, prefix: /^sk-ant-api\d+-/ }),
  guide: {
    url: () => 'https://console.anthropic.com/settings/keys',
    steps: (c) => [`Click "Create Key" (name it after ${c.label})`, 'Copy the key and paste it below'],
    pattern: /^sk-ant-api\d+-[\w-]{20,}$/,
    afterwards: 'Disable or delete the old key in the Anthropic Console.',
  },
  auth: [
    {
      key: 'admin_key',
      label: 'Admin API key (optional)',
      secret: true,
      optional: true,
      help: 'With an sk-ant-admin key Molly also deactivates the old key for you. Leave blank to skip.',
    },
  ],
  async resolveKeyId(ctx, _cred, current) {
    const admin = await ctx.authOptional('admin_key');
    if (!admin || !current.secret) return undefined;
    const res = await request('https://api.anthropic.com/v1/organizations/api_keys?limit=1000&status=active', {
      headers: { 'x-api-key': admin, 'anthropic-version': '2023-06-01' },
    });
    const hits = (res.data ?? []).filter((k: any) => {
      const [pre, suf] = String(k.partial_key_hint ?? '').split(/\.\.\.|…/);
      return pre && suf && current.secret.startsWith(pre) && current.secret.endsWith(suf);
    });
    return hits.length === 1 ? hits[0].id : undefined;
  },
  async revoke(ctx, _cred, keyId) {
    await request(`https://api.anthropic.com/v1/organizations/api_keys/${keyId}`, {
      headers: { 'x-api-key': await ctx.auth('admin_key'), 'anthropic-version': '2023-06-01' },
      json: { status: 'inactive' },
    });
  },
  async verify(_ctx, _cred, values) {
    await request('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': values.secret, 'anthropic-version': '2023-06-01' },
    });
  },
};

export const githubPat: Provider = {
  id: 'github-pat',
  name: 'GitHub tokens',
  category: 'code',
  mode: 'guided',
  blurb: 'Personal access tokens used by your apps (regenerate in GitHub, Molly propagates)',
  fields: ['secret'],
  dashboardUrl: 'https://github.com/settings/tokens',
  detect: simpleDetector('github-pat', 'secret', { prefix: /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})$/ }),
  guide: {
    url: (_c, cur) =>
      cur.secret?.startsWith('github_pat_') ? 'https://github.com/settings/personal-access-tokens' : 'https://github.com/settings/tokens',
    steps: (c) => [`Open the token used for ${c.label} and click "Regenerate token"`, 'Copy the new token and paste it below'],
    pattern: /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})$/,
    afterwards: 'Regenerating invalidated the old token already.',
  },
  async verify(_ctx, _cred, values) {
    await request('https://api.github.com/user', { headers: bearer(values.secret) });
  },
};

export const clerk: Provider = {
  id: 'clerk',
  name: 'Clerk',
  category: 'auth',
  mode: 'guided',
  blurb: 'Roll secret keys in the Clerk dashboard, Molly updates every repo',
  fields: ['secret'],
  dashboardUrl: 'https://dashboard.clerk.com',
  detect: simpleDetector('clerk', 'secret', { names: /CLERK_SECRET_KEY$/, shape: /^sk_(live|test)_/ }),
  guide: {
    url: () => 'https://dashboard.clerk.com/last-active?path=api-keys',
    steps: () => ['Under "Secret keys", add a new key', 'Copy it and paste it below'],
    pattern: /^sk_(live|test)_[A-Za-z0-9]{20,}$/,
    afterwards: 'Delete the old secret key in the Clerk dashboard.',
  },
  async verify(_ctx, _cred, values) {
    await request('https://api.clerk.com/v1/users?limit=1', { headers: bearer(values.secret) });
  },
};
