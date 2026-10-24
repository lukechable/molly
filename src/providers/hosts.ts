import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { bearer, request } from '../core/util.js';
import { cliLogin } from './cli.js';
import type { Provider } from './types.js';

const exec = promisify(execFile);

export const github: Provider = {
  id: 'github',
  name: 'GitHub',
  category: 'code',
  mode: 'host',
  blurb: 'Updates repo and environment secrets for each repo Molly finds',
  loginUrl: 'https://github.com/settings/tokens/new?scopes=repo&description=molly',
  cliLogin: cliLogin('GitHub CLI', 'gh', ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--scopes', 'repo']),
  fields: [],
  auth: [
    {
      key: 'token',
      label: 'GitHub token',
      secret: true,
      help: 'Uses `gh auth token` automatically if the GitHub CLI is logged in. Needs repo secrets write.',
    },
  ],
  async autoAuth() {
    try {
      const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 5000 });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  },
  async checkAuth(ctx) {
    const me = await request('https://api.github.com/user', { headers: bearer(await ctx.auth('token')) });
    return `@${me.login}`;
  },
};

function vercelCliAuthPaths(): string[] {
  const home = os.homedir();
  const data = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return [
    path.join(home, 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
    path.join(data, 'com.vercel.cli', 'auth.json'),
    path.join(process.env.APPDATA ?? '', 'com.vercel.cli', 'auth.json'),
  ];
}

export const vercel: Provider = {
  id: 'vercel',
  name: 'Vercel',
  category: 'code',
  mode: 'host',
  blurb: 'Updates environment variables for linked projects (and can redeploy)',
  loginUrl: 'https://vercel.com/account/tokens',
  cliLogin: cliLogin('Vercel CLI', 'vercel', ['login']),
  fields: [],
  auth: [
    {
      key: 'token',
      label: 'Vercel token',
      secret: true,
      help: 'Uses your Vercel CLI login if present, otherwise vercel.com/account/tokens',
    },
  ],
  async autoAuth() {
    if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
    for (const p of vercelCliAuthPaths()) {
      try {
        const j = JSON.parse(await fs.readFile(p, 'utf8'));
        if (j.token) return j.token;
      } catch {}
    }
    return undefined;
  },
  async checkAuth(ctx) {
    const me = await request('https://api.vercel.com/v2/user', { headers: bearer(await ctx.auth('token')) });
    return me.user?.username ?? 'connected';
  },
};
