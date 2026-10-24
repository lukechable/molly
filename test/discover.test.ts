import { describe, expect, it } from 'vitest';
import { discover, envOf, isEnvFile } from '../src/core/discover.js';
import { createDemoWorkspace, demoRuntime } from '../src/demo.js';

describe('discovery', () => {
  it('recognises env files and their environments', () => {
    expect(isEnvFile('.env')).toBe(true);
    expect(isEnvFile('.env.production.local')).toBe(true);
    expect(isEnvFile('.dev.vars')).toBe(true);
    expect(isEnvFile('.env.example')).toBe(false);
    expect(isEnvFile('env.ts')).toBe(false);
    expect(envOf('/x/.env.production')).toBe('production');
    expect(envOf('/x/.env.local')).toBe('development');
    expect(envOf('/x/.env')).toBeUndefined();
  });

  it('groups copies of a key across repos and links remote secrets safely', async () => {
    const { root } = await createDemoWorkspace();
    const rt = demoRuntime();
    const { repos, drafts, warnings } = await discover(rt, [root], Object.keys(rt.registry));
    expect(repos.map((r) => r.github).sort()).toEqual(['acme/api', 'acme/web', 'acme/worker']);

    const byId = Object.fromEntries(drafts.map((d) => [d.cred.id, d.cred]));
    const openai = byId['openai-openai-api-key'];
    expect(openai.targets.map((t) => t.type).sort()).toEqual(['dotenv', 'dotenv', 'github', 'github', 'vercel']);

    // AWS id + secret pair shared by api and worker is one credential.
    expect(byId['aws-aws-access-key-id'].targets.filter((t) => t.type === 'dotenv')).toHaveLength(4);

    // Neon URLs (pooled + direct) become templates around a single password.
    const neon = byId['neon-database-url'];
    expect(neon.targets.every((t) => t.value?.includes('{{password:url}}'))).toBe(true);

    // Test and live Stripe keys stay separate; the ambiguous repo-level secret is not linked.
    const stripe = drafts.filter((d) => d.cred.platform === 'stripe');
    expect(stripe).toHaveLength(2);
    expect(new Set(stripe.map((d) => d.cred.label)).size).toBe(2);
    const live = stripe.find((d) => d.cred.label.includes('.env.production'))!;
    expect(live.cred.targets.find((t) => t.type === 'github')?.environment).toBe('production');
    expect(warnings.some((w) => w.includes('repo secret STRIPE_SECRET_KEY'))).toBe(true);

    // .env.example placeholders are ignored.
    expect(drafts.flatMap((d) => d.cred.targets).some((t) => t.path?.endsWith('.example'))).toBe(false);
  });
});
