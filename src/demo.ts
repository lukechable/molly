import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Runtime } from './core/runtime.js';
import { MemoryStore } from './core/store.js';
import { sleep } from './core/util.js';
import { liveRegistry } from './providers/index.js';
import type { Provider } from './providers/types.js';
import { dotenvDriver } from './targets/remotes.js';
import type { Remotes, TargetDriver } from './targets/types.js';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const rand = (n: number, alphabet = ALNUM) => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('');
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** Realistic-looking (but fake) values per platform, so the demo exercises the real detectors. */
export function fakeValue(provider: string, field: string): string {
  switch (`${provider}.${field}`) {
    case 'openai.secret':
      return `sk-proj-${rand(48)}`;
    case 'anthropic.secret':
      return `sk-ant-api03-${rand(86)}AA`;
    case 'aws.access_key_id':
      return `AKIA${rand(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')}`;
    case 'aws.secret_access_key':
      return rand(40);
    case 'stripe.secret':
      return `sk_test_${rand(40)}`;
    case 'resend.secret':
      return `re_${rand(8)}_${rand(24)}`;
    case 'neon.password':
      return `npg_${rand(12)}`;
    case 'datadog.secret':
      return hex(16);
    case 'cloudflare.secret':
      return rand(40);
    case 'sendgrid.secret':
      return `SG.${rand(22)}.${rand(43)}`;
    case 'twilio.sid':
      return `SK${hex(16)}`;
    case 'clerk.secret':
      return `sk_test_${rand(40)}`;
    case 'supabase.secret':
      return `sb_secret_${rand(32)}`;
    case 'github-pat.secret':
      return `ghp_${rand(36)}`;
    default:
      return rand(32);
  }
}

const IMMEDIATE = new Set(['cloudflare', 'neon', 'generated']);

let githubLoggedIn = false;

function demoProvider(p: Provider): Provider {
  // GitHub starts logged out so the demo shows a browser login.
  if (p.id === 'github') {
    p = {
      ...p,
      autoAuth: async () => (githubLoggedIn ? 'demo' : undefined),
      cliLogin: {
        label: 'GitHub CLI',
        available: async () => true,
        async run() {
          process.stdout.write('\n  (demo) Opening github.com/login/device in your browser…\n');
          await sleep(1200);
          process.stdout.write('  (demo) ✓ Logged in as @acme\n\n');
          await sleep(600);
          githubLoggedIn = true;
        },
      },
    };
  }
  return {
    ...p,
    autoAuth: p.id === 'github' ? p.autoAuth : p.auth ? async () => 'demo' : undefined,
    checkAuth: p.checkAuth && (async () => (await sleep(300), p.mode === 'host' ? '@acme (demo)' : 'demo account')),
    prepare:
      p.prepare &&
      (async (_ctx, cred) => {
        await sleep(150);
        if (p.id === 'openai') cred.params.project_id = 'proj_demo';
        if (p.id === 'aws') cred.params.user = 'deploy-bot';
        if (p.id === 'neon') Object.assign(cred.params, { project_id: 'demo-project', branch_id: 'br-main' });
      }),
    resolveKeyId: p.resolveKeyId && (async () => (p.id === 'anthropic' ? undefined : `old_${rand(8)}`)),
    issue:
      p.mode === 'auto'
        ? async (ctx, cred, keyId) => {
            await sleep(600);
            if (p.id === 'generated') return p.issue!(ctx, cred, keyId);
            const values = Object.fromEntries(p.fields.map((f) => [f, fakeValue(p.id, f)]));
            return { keyId: IMMEDIATE.has(p.id) ? keyId : `key_${rand(8)}`, values, immediate: IMMEDIATE.has(p.id) };
          }
        : undefined,
    revoke: p.revoke && (async () => void (await sleep(350))),
    verify: p.verify && (async () => void (await sleep(400))),
    sample: (field) => fakeValue(p.id, field),
  };
}

const slowly = (ms: number): TargetDriver => ({
  check: async () => void (await sleep(40)),
  write: async () => void (await sleep(ms)),
});

export function demoRuntime(): Runtime {
  const registry = Object.fromEntries(Object.values(liveRegistry()).map((p) => [p.id, demoProvider(p)]));
  const github: Record<string, { repo: string[]; environments: Record<string, string[]> }> = {
    'acme/web': { repo: ['OPENAI_API_KEY', 'DATABASE_URL'], environments: {} },
    'acme/api': {
      repo: ['OPENAI_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY'],
      environments: { production: ['STRIPE_SECRET_KEY', 'JWT_SECRET'] },
    },
    'acme/worker': { repo: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'DD_API_KEY'], environments: {} },
  };
  const remotes: Remotes = {
    drivers: { dotenv: dotenvDriver, github: slowly(220), vercel: slowly(260) },
    async githubSecrets(slug) {
      await sleep(250);
      return github[slug] ?? { repo: [], environments: {} };
    },
    async vercelEnv() {
      await sleep(250);
      return ['OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'DATABASE_URL', 'NEXTAUTH_SECRET'].map((key, i) => ({
        id: `env_${i}`,
        key,
        type: 'sensitive',
        target: ['production', 'preview', 'development'],
      }));
    },
    async vercelRedeploy() {
      await sleep(500);
      return 'acme-web-7h2k.vercel.app';
    },
  };
  return { registry, store: new MemoryStore(), remotes, demo: true };
}

/** Builds three throwaway repos with .env files under a temp dir. Returns [reposRoot, mollyHome]. */
export async function createDemoWorkspace(): Promise<{ root: string; home: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'molly-demo-'));
  const root = path.join(base, 'code');
  const home = path.join(base, 'molly-home');

  const openai = fakeValue('openai', 'secret');
  const stripeTest = fakeValue('stripe', 'secret');
  const stripeLive = `sk_live_${rand(40)}`;
  const awsId = fakeValue('aws', 'access_key_id');
  const awsSecret = fakeValue('aws', 'secret_access_key');
  const neonPw = fakeValue('neon', 'password');
  const neonHost = 'ep-cool-river-a1b2c3d4';
  const dbPooled = `postgresql://neondb_owner:${neonPw}@${neonHost}-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require`;
  const dbDirect = `postgresql://neondb_owner:${neonPw}@${neonHost}.us-east-2.aws.neon.tech/neondb?sslmode=require`;

  const repos: Record<string, { slug: string; vercel?: boolean; files: Record<string, string> }> = {
    'acme-web': {
      slug: 'acme/web',
      vercel: true,
      files: {
        '.env.local': [
          '# Next.js app',
          'NEXT_PUBLIC_APP_URL=http://localhost:3000',
          `OPENAI_API_KEY=${openai}`,
          `STRIPE_SECRET_KEY="${stripeTest}"`,
          `DATABASE_URL="${dbPooled}"`,
          `NEXTAUTH_SECRET=${randomBytes(32).toString('base64')}`,
          '',
        ].join('\n'),
      },
    },
    'acme-api': {
      slug: 'acme/api',
      files: {
        '.env': [
          'PORT=8080',
          `OPENAI_API_KEY=${openai}  # shared with web`,
          `ANTHROPIC_API_KEY=${fakeValue('anthropic', 'secret')}`,
          `STRIPE_SECRET_KEY=${stripeTest}`,
          `AWS_ACCESS_KEY_ID=${awsId}`,
          `AWS_SECRET_ACCESS_KEY=${awsSecret}`,
          `RESEND_API_KEY=${fakeValue('resend', 'secret')}`,
          `DATABASE_URL=${dbPooled}`,
          `DATABASE_URL_UNPOOLED=${dbDirect}`,
          `JWT_SECRET=${hex(32)}`,
          '',
        ].join('\n'),
        '.env.production': [`STRIPE_SECRET_KEY=${stripeLive}`, ''].join('\n'),
        '.env.example': ['OPENAI_API_KEY=your-key-here', ''].join('\n'),
      },
    },
    'acme-worker': {
      slug: 'acme/worker',
      files: {
        '.env': [
          `export AWS_ACCESS_KEY_ID=${awsId}`,
          `export AWS_SECRET_ACCESS_KEY=${awsSecret}`,
          `DD_API_KEY=${hex(16)}`,
          'QUEUE=jobs',
          '',
        ].join('\n'),
      },
    },
  };

  for (const [name, repo] of Object.entries(repos)) {
    const dir = path.join(root, name);
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.git', 'config'),
      `[remote "origin"]\n\turl = git@github.com:${repo.slug}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    );
    if (repo.vercel) {
      await fs.mkdir(path.join(dir, '.vercel'), { recursive: true });
      await fs.writeFile(
        path.join(dir, '.vercel', 'project.json'),
        JSON.stringify({ projectId: 'prj_demo_web', orgId: 'team_demo', projectName: name }),
      );
    }
    for (const [file, content] of Object.entries(repo.files)) await fs.writeFile(path.join(dir, file), content, { mode: 0o600 });
  }
  return { root, home };
}
