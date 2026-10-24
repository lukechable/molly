import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyConfig, type CredentialSpec, type MollyConfig } from '../src/core/config.js';
import { readDotenv } from '../src/core/dotenv.js';
import { finalize, preflight, rollAll, type PromptRequest, type RollEvent } from '../src/core/engine.js';
import type { Runtime } from '../src/core/runtime.js';
import { authKey, MemoryStore, stashKey } from '../src/core/store.js';
import { fingerprint } from '../src/core/util.js';
import type { Provider } from '../src/providers/types.js';
import { dotenvDriver } from '../src/targets/remotes.js';
import type { TargetDriver } from '../src/targets/types.js';

let dir: string;
let n = 0;
const log: string[] = [];

function fakeProvider(over: Partial<Provider> = {}): Provider {
  return {
    id: 'fake',
    name: 'Fake',
    category: 'ai',
    mode: 'auto',
    blurb: '',
    fields: ['secret'],
    dashboardUrl: 'https://fake.example',
    async issue() {
      n++;
      log.push(`issue:${n}`);
      return { keyId: `k${n}`, values: { secret: `new-secret-${n}` } };
    },
    async revoke(_c, _cred, id) {
      log.push(`revoke:${id}`);
    },
    ...over,
  };
}

function runtime(provider: Provider, remote: Partial<TargetDriver> = {}): Runtime {
  const remoteDriver: TargetDriver = { check: async () => {}, write: async (_t, v) => void log.push(`remote:${v}`), ...remote };
  return {
    registry: { [provider.id]: provider },
    store: new MemoryStore(),
    remotes: {
      drivers: { dotenv: dotenvDriver, github: remoteDriver, vercel: remoteDriver },
      githubSecrets: async () => ({ repo: [], environments: {} }),
      vercelEnv: async () => [],
      vercelRedeploy: async () => 'x',
    },
  };
}

async function setup(provider = 'fake', value = 'old-secret-0000'): Promise<MollyConfig> {
  const file = path.join(dir, '.env');
  await fs.writeFile(file, `# app\nAPI_KEY=${value}\nOTHER=1\n`);
  const cred: CredentialSpec = {
    id: 'cred',
    platform: provider,
    label: 'API_KEY',
    params: {},
    state: {},
    targets: [
      { type: 'dotenv', key: 'API_KEY', value: '{{secret}}', path: file, fingerprint: fingerprint(value) },
      { type: 'github', key: 'API_KEY', value: '{{secret}}', slug: 'o/r' },
    ],
  };
  return { ...emptyConfig(), platforms: [provider], credentials: [cred] };
}

function io(answers: (string | null)[] = []) {
  const events: RollEvent[] = [];
  const prompts: PromptRequest[] = [];
  return {
    events,
    prompts,
    io: {
      emit: (e: RollEvent) => events.push(e),
      prompt: async (req: PromptRequest) => (prompts.push(req), answers.shift() ?? null),
    },
  };
}

const done = (events: RollEvent[]) => events.filter((e) => e.type === 'cred-done') as Extract<RollEvent, { type: 'cred-done' }>[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'molly-test-'));
  n = 0;
  log.length = 0;
});

describe('roll engine', () => {
  it('issues, updates every target, then revokes the old key', async () => {
    const cfg = await setup();
    cfg.credentials[0].state.keyId = 'k0';
    const rt = runtime(fakeProvider());
    const t = io();
    await rollAll(rt, cfg, t.io, {}, async () => {});
    expect(done(t.events)[0].status).toBe('rolled');
    expect((await readDotenv(path.join(dir, '.env'))).get('API_KEY')).toBe('new-secret-1');
    expect(await fs.readFile(path.join(dir, '.env'), 'utf8')).toContain('# app\n');
    expect(log).toEqual(['issue:1', 'remote:new-secret-1', 'revoke:k0']);
    expect(cfg.credentials[0].state.keyId).toBe('k1');
    expect(await rt.store.get(stashKey('cred'))).toBeNull();
  });

  it('does not revoke when a target fails, and resumes with the same new key', async () => {
    const cfg = await setup();
    cfg.credentials[0].state.keyId = 'k0';
    let fail = true;
    const rt = runtime(fakeProvider(), {
      write: async (_t, v) => {
        if (fail) throw new Error('GitHub is down');
        log.push(`remote:${v}`);
      },
    });
    const first = io();
    await rollAll(rt, cfg, first.io, {}, async () => {});
    expect(done(first.events)[0].status).toBe('partial');
    expect(log).toEqual(['issue:1']);
    expect(await rt.store.get(stashKey('cred'))).not.toBeNull();

    fail = false;
    const plan = await preflight(rt, cfg);
    expect(plan[0].resuming).toBe(true);
    const second = io();
    await rollAll(rt, cfg, second.io, {}, async () => {});
    expect(done(second.events)[0].status).toBe('rolled');
    expect(log).toEqual(['issue:1', 'remote:new-secret-1', 'revoke:k0']); // no second issue
    expect(cfg.credentials[0].state.keyId).toBe('k1');
  });

  it('refuses to overwrite a value edited outside Molly unless forced', async () => {
    const cfg = await setup();
    await fs.writeFile(cfg.credentials[0].targets[0].path!, 'API_KEY=someone-elses-key-123\n');
    const rt = runtime(fakeProvider());
    const plan = await preflight(rt, cfg);
    expect(plan[0].problems[0].drift).toBe(true);
    const t = io();
    await rollAll(rt, cfg, t.io, {}, async () => {});
    expect(done(t.events)[0].status).toBe('partial');
    expect((await readDotenv(cfg.credentials[0].targets[0].path!)).get('API_KEY')).toBe('someone-elses-key-123');

    const forced = io();
    await rollAll(rt, cfg, forced.io, { force: true }, async () => {});
    expect(done(forced.events)[0].status).toBe('rolled');
  });

  it('defers revocation with keepOld and finalizes later', async () => {
    const cfg = await setup();
    cfg.credentials[0].state.keyId = 'k0';
    const rt = runtime(fakeProvider());
    await rollAll(rt, cfg, io().io, { keepOld: true }, async () => {});
    expect(log).not.toContain('revoke:k0');
    expect(cfg.credentials[0].state.pendingRevoke?.[0].keyId).toBe('k0');
    await finalize(rt, cfg, () => {});
    expect(log).toContain('revoke:k0');
    expect(cfg.credentials[0].state.pendingRevoke).toBeUndefined();
  });

  it('tells you to revoke manually on a first roll when the old key id is unknown', async () => {
    const cfg = await setup();
    const t = io();
    await rollAll(runtime(fakeProvider()), cfg, t.io, {}, async () => {});
    expect(done(t.events)[0].followUps[0]).toMatch(/revoke it yourself at https:\/\/fake.example/);
  });

  it('guided: validates the pasted key before touching anything', async () => {
    const cfg = await setup('guided', 'sk_test_old000000000000000000');
    const provider = fakeProvider({
      id: 'guided',
      mode: 'guided',
      issue: undefined,
      revoke: undefined,
      guide: { url: () => 'https://dash', steps: () => ['click roll'], pattern: /^sk_test_/, afterwards: 'old key expires' },
      async verify(_c, _cred, v) {
        if (v.secret.includes('bad')) throw new Error('401');
      },
    });
    const rt = runtime(provider);
    const t = io(['sk_test_new11111111111111111111']);
    await rollAll(rt, cfg, t.io, {}, async () => {});
    const req = t.prompts[0];
    expect(await req.validate('nope')).toMatch(/right kind/);
    expect(await req.validate('sk_test_old000000000000000000')).toMatch(/old key/);
    expect(await req.validate('sk_test_bad')).toMatch(/didn't work/);
    expect(await req.validate('sk_test_good')).toBeUndefined();
    expect((await readDotenv(cfg.credentials[0].targets[0].path!)).get('API_KEY')).toBe('sk_test_new11111111111111111111');
    expect(done(t.events)[0].followUps).toEqual(['old key expires']);
  });

  it('guided: skipping leaves everything untouched', async () => {
    const cfg = await setup('guided');
    const provider = fakeProvider({ id: 'guided', mode: 'guided', issue: undefined, guide: { url: () => '', steps: () => [] } });
    const t = io([null]);
    await rollAll(runtime(provider), cfg, t.io, {}, async () => {});
    expect(done(t.events)[0].status).toBe('skipped');
    expect((await readDotenv(cfg.credentials[0].targets[0].path!)).get('API_KEY')).toBe('old-secret-0000');
  });

  it('keeps the stored platform credential in sync when Molly rolls its own admin key', async () => {
    const cfg = await setup();
    const rt = runtime(fakeProvider({ auth: [{ key: 'api_key', label: 'key', secret: true }] }));
    await rt.store.set(authKey('fake', 'api_key'), 'old-secret-0000');
    await rollAll(rt, cfg, io().io, {}, async () => {});
    expect(await rt.store.get(authKey('fake', 'api_key'))).toBe('new-secret-1');
  });
});
