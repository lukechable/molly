import sodium from 'libsodium-wrappers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialSpec } from '../src/core/config.js';
import type { ProviderContext } from '../src/providers/types.js';
import { cloudflare } from '../src/providers/cloudflare.js';
import { openai } from '../src/providers/openai.js';
import { sendgrid } from '../src/providers/messaging.js';
import { liveRemotes } from '../src/targets/remotes.js';

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

function mockFetch(routes: Record<string, (c: Call) => any>) {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    const call: Call = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body && JSON.parse(init.body) };
    calls.push(call);
    const key = Object.keys(routes).find((k) => `${call.method} ${url}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ error: { message: 'no route' } }), { status: 404 });
    return new Response(JSON.stringify(routes[key](call) ?? {}), { status: 200 });
  });
  return calls;
}

const ctx = (auth: Record<string, string>): ProviderContext => ({
  params: {},
  auth: async (f) => auth[f],
  authOptional: async (f) => auth[f],
});
const cred = (params: Record<string, string> = {}): CredentialSpec => ({ id: 'c', platform: 'x', label: 'KEY', params, targets: [], state: {} });

afterEach(() => vi.unstubAllGlobals());

describe('openai', () => {
  it('finds the current key by its redacted value and rotates via service accounts', async () => {
    const calls = mockFetch({
      'GET https://api.openai.com/v1/organization/projects?': () => ({ data: [{ id: 'proj_1', name: 'App' }], has_more: false }),
      'GET https://api.openai.com/v1/organization/projects/proj_1/api_keys': () => ({
        data: [{ id: 'key_9', redacted_value: 'sk-proj-ab...wxyz', owner: { type: 'user' } }],
        has_more: false,
      }),
      'POST https://api.openai.com/v1/organization/projects/proj_1/service_accounts': () => ({
        id: 'svc_acct_1',
        api_key: { value: 'sk-svcacct-new', id: 'key_new' },
      }),
      'DELETE https://api.openai.com/v1/organization/projects/proj_1/api_keys/key_9': () => ({ deleted: true }),
    });
    const c = cred();
    await openai.prepare!(ctx({ admin_key: 'sk-admin-x' }), c, { secret: 'sk-proj-ab1234567890wxyz' });
    expect(c.params.project_id).toBe('proj_1');
    expect(c.state.keyId).toBe('key:key_9');

    const issued = await openai.issue!(ctx({ admin_key: 'sk-admin-x' }), c);
    expect(issued).toEqual({ keyId: 'svc:svc_acct_1', values: { secret: 'sk-svcacct-new' } });
    await openai.revoke!(ctx({ admin_key: 'sk-admin-x' }), c, 'key:key_9');
    expect(calls.at(-1)!.method).toBe('DELETE');
    expect(calls.every((c) => c.headers.authorization === 'Bearer sk-admin-x')).toBe(true);
  });
});

describe('cloudflare', () => {
  it('rolls the token in place', async () => {
    mockFetch({
      'PUT https://api.cloudflare.com/client/v4/user/tokens/tok_1/value': () => ({ result: 'new-token-value' }),
    });
    const issued = await cloudflare.issue!(ctx({ api_token: 'admin' }), cred(), 'tok_1');
    expect(issued).toEqual({ keyId: 'tok_1', values: { secret: 'new-token-value' }, immediate: true });
  });
});

describe('sendgrid', () => {
  it('copies scopes from the current key (wrapped response shape)', async () => {
    const calls = mockFetch({
      'GET https://api.sendgrid.com/v3/api_keys/old': () => ({ result: [{ api_key_id: 'old', scopes: ['mail.send'] }] }),
      'POST https://api.sendgrid.com/v3/api_keys': () => ({ api_key: 'SG.new.key', api_key_id: 'new' }),
    });
    const issued = await sendgrid.issue!(ctx({ api_key: 'SG.admin' }), cred(), 'old');
    expect(issued.values.secret).toBe('SG.new.key');
    expect(calls.at(-1)!.body.scopes).toEqual(['mail.send']);
  });
});

describe('github target', () => {
  it('writes Actions secrets as libsodium sealed boxes', async () => {
    await sodium.ready;
    const kp = sodium.crypto_box_keypair();
    const calls = mockFetch({
      'GET https://api.github.com/repos/o/r/actions/secrets/public-key': () => ({
        key_id: 'kid',
        key: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
      }),
      'PUT https://api.github.com/repos/o/r/actions/secrets/API_KEY': () => ({}),
    });
    const remotes = liveRemotes(async () => 'ghtoken');
    await remotes.drivers.github.write({ type: 'github', key: 'API_KEY', slug: 'o/r' }, 'super-secret');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body.key_id).toBe('kid');
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(put.body.encrypted_value, sodium.base64_variants.ORIGINAL),
      kp.publicKey,
      kp.privateKey,
    );
    expect(sodium.to_string(opened)).toBe('super-secret');
  });
});
