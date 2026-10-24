import sodium from 'libsodium-wrappers';
import { readDotenv, writeDotenvValue } from '../core/dotenv.js';
import { fingerprint, bearer, request } from '../core/util.js';
import type { TargetSpec } from '../core/config.js';
import type { Remotes, TargetDriver, VercelEnv } from './types.js';

export type TokenSource = (platform: 'github' | 'vercel') => Promise<string>;

export const dotenvDriver: TargetDriver = {
  async check(t) {
    const vars = await readDotenv(t.path!);
    if (!vars.has(t.key)) throw new Error(`${t.key} is no longer in this file`);
    if (t.fingerprint && fingerprint(vars.get(t.key)!) !== t.fingerprint) {
      throw new DriftError(`${t.key} was changed outside Molly since setup`);
    }
  },
  async read(t) {
    return (await readDotenv(t.path!)).get(t.key);
  },
  async write(t, value) {
    await writeDotenvValue(t.path!, t.key, value);
    t.fingerprint = fingerprint(value);
  },
};

/** The local value no longer matches what Molly linked; overwriting needs --force. */
export class DriftError extends Error {}

const GH = 'https://api.github.com';

function githubDriver(token: TokenSource): TargetDriver {
  const headers = async () => ({ ...bearer(await token('github')), 'x-github-api-version': '2022-11-28' });
  const base = (t: TargetSpec) =>
    t.environment
      ? `${GH}/repos/${t.slug}/environments/${encodeURIComponent(t.environment)}/secrets`
      : `${GH}/repos/${t.slug}/actions/secrets`;
  return {
    async check(t) {
      await request(`${base(t)}/public-key`, { headers: await headers() });
    },
    async write(t, value) {
      const h = await headers();
      const pk = await request(`${base(t)}/public-key`, { headers: h });
      await sodium.ready;
      const sealed = sodium.crypto_box_seal(
        sodium.from_string(value),
        sodium.from_base64(pk.key, sodium.base64_variants.ORIGINAL),
      );
      await request(`${base(t)}/${t.key}`, {
        method: 'PUT',
        headers: h,
        json: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: pk.key_id },
      });
    },
  };
}

const VC = 'https://api.vercel.com';
const team = (teamId?: string) => (teamId ? `teamId=${encodeURIComponent(teamId)}` : '');

function vercelDriver(token: TokenSource, list: (p: string, t?: string) => Promise<VercelEnv[]>): TargetDriver {
  return {
    async check(t) {
      const envs = await list(t.projectId!, t.teamId);
      const missing = (t.envIds ?? []).filter((id) => !envs.some((e) => e.id === id));
      if (missing.length) throw new Error(`${t.key} was removed from the Vercel project`);
    },
    async write(t, value) {
      for (const id of t.envIds ?? []) {
        await request(`${VC}/v9/projects/${t.projectId}/env/${id}?${team(t.teamId)}`, {
          method: 'PATCH',
          headers: bearer(await token('vercel')),
          json: { value },
        });
      }
    },
  };
}

export function liveRemotes(token: TokenSource): Remotes {
  async function vercelEnv(projectId: string, teamId?: string): Promise<VercelEnv[]> {
    const res = await request(`${VC}/v10/projects/${projectId}/env?decrypt=true&${team(teamId)}`, {
      headers: bearer(await token('vercel')),
    });
    const envs: any[] = res.envs ?? (Array.isArray(res) ? res : [res]);
    return envs.map((e) => ({
      id: e.id,
      key: e.key,
      type: e.type,
      target: [].concat(e.target ?? []),
      // Sensitive variables can't be decrypted; Vercel returns them blank or still encrypted.
      value: e.type !== 'sensitive' && e.decrypted !== false && typeof e.value === 'string' ? e.value : undefined,
    }));
  }
  return {
    drivers: { dotenv: dotenvDriver, github: githubDriver(token), vercel: vercelDriver(token, vercelEnv) },
    async githubSecrets(slug) {
      const headers = bearer(await token('github'));
      const names = (r: any) => (r.secrets ?? []).map((s: any) => s.name as string);
      const repo = names(await request(`${GH}/repos/${slug}/actions/secrets?per_page=100`, { headers }));
      const environments: Record<string, string[]> = {};
      const envs = await request(`${GH}/repos/${slug}/environments?per_page=100`, { headers, allow: [404] });
      for (const env of envs.environments ?? []) {
        const r = await request(`${GH}/repos/${slug}/environments/${encodeURIComponent(env.name)}/secrets?per_page=100`, {
          headers,
        });
        environments[env.name] = names(r);
      }
      return { repo, environments };
    },
    vercelEnv,
    async vercelRedeploy(projectId, teamId) {
      const headers = bearer(await token('vercel'));
      const q = team(teamId);
      const list = await request(`${VC}/v7/deployments?projectId=${projectId}&target=production&state=READY&limit=1&${q}`, {
        headers,
      });
      const latest = list.deployments?.[0];
      if (!latest) throw new Error('no production deployment to redeploy');
      const res = await request(`${VC}/v13/deployments?${q}`, {
        headers,
        json: { name: latest.name, deploymentId: latest.uid, target: 'production' },
      });
      return res.url ?? latest.name;
    },
  };
}
