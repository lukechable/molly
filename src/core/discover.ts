import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Detection } from '../providers/types.js';
import type { CredentialSpec, TargetSpec } from './config.js';
import { readDotenv } from './dotenv.js';
import type { Runtime } from './runtime.js';
import { fingerprint, renderTemplate, slug } from './util.js';

export interface RepoInfo {
  root: string;
  name: string;
  isGit: boolean;
  envFiles: string[];
  github?: string;
  vercel: { projectId: string; teamId?: string; name: string }[];
}

const SKIP = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache',
  'target', 'venv', '.venv', '__pycache__', 'Pods', 'DerivedData', '.terraform', 'coverage', 'tmp', '.output',
  'Library', 'Applications', 'Pictures', 'Music', 'Movies',
]);
const ENV_FILE = /^(\.env(\.[\w.-]+)?|\.dev\.vars)$/;
const NOT_REAL = /\.(example|sample|template|dist|defaults|schema|tpl|bak)$/i;

export function isEnvFile(name: string) {
  return ENV_FILE.test(name) && !NOT_REAL.test(name);
}

/** Maps an env file to the deployment environment it most likely mirrors. */
export function envOf(file: string): string | undefined {
  const parts = path.basename(file).split('.').slice(2);
  for (const p of parts) {
    if (/^prod(uction)?$/.test(p)) return 'production';
    if (/^(staging|stage|stg)$/.test(p)) return 'staging';
    if (p === 'preview') return 'preview';
    if (/^(dev|development|local)$/.test(p)) return 'development';
    if (p === 'test') return 'test';
  }
  return undefined;
}

async function githubSlug(root: string): Promise<string | undefined> {
  let gitDir = path.join(root, '.git');
  try {
    const stat = await fs.stat(gitDir);
    if (stat.isFile()) {
      const pointer = (await fs.readFile(gitDir, 'utf8')).match(/gitdir:\s*(.+)/)?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = path.resolve(root, pointer);
      const common = await fs.readFile(path.join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
      if (common) gitDir = path.resolve(gitDir, common.trim());
    }
    const cfg = await fs.readFile(path.join(gitDir, 'config'), 'utf8');
    const origin = cfg.split(/^\[/m).find((s) => s.startsWith('remote "origin"')) ?? cfg;
    return /url\s*=\s*\S*github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/m.exec(origin)?.[1];
  } catch {
    return undefined;
  }
}

/** Walks `roots` for git repos (and loose project folders) that contain env files or Vercel links. */
export async function findRepos(roots: string[], maxDepth = 6): Promise<RepoInfo[]> {
  const repos = new Map<string, RepoInfo>();
  const repoFor = (root: string, isGit: boolean) => {
    let r = repos.get(root);
    if (!r) repos.set(root, (r = { root, name: path.basename(root), isGit, envFiles: [], vercel: [] }));
    return r;
  };

  async function walk(dir: string, depth: number, repo: RepoInfo | undefined) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === '.git')) {
      repo = repoFor(dir, true);
      repo.github = await githubSlug(dir);
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && isEnvFile(e.name)) {
        (repo ?? repoFor(dir, false)).envFiles.push(full);
      } else if (e.isDirectory() && e.name === '.vercel') {
        try {
          const j = JSON.parse(await fs.readFile(path.join(full, 'project.json'), 'utf8'));
          if (j.projectId) {
            (repo ?? repoFor(dir, false)).vercel.push({
              projectId: j.projectId,
              teamId: j.orgId?.startsWith('team_') ? j.orgId : undefined,
              name: j.projectName ?? path.basename(dir),
            });
          }
        } catch {}
      } else if (e.isDirectory() && depth < maxDepth && !SKIP.has(e.name) && !e.name.startsWith('.')) {
        await walk(full, depth + 1, repo);
      }
    }
  }

  for (const root of roots) await walk(path.resolve(root), 0, undefined);
  return [...repos.values()].filter((r) => r.envFiles.length || r.vercel.length);
}

export interface Hit extends Detection {
  file: string;
  repo: RepoInfo;
}

export interface Draft {
  cred: CredentialSpec;
  /** Current values by field, read from local files. Never persisted. */
  current: Record<string, string>;
  repos: string[];
  hits: Hit[];
}

export interface Discovery {
  repos: RepoInfo[];
  drafts: Draft[];
  warnings: string[];
  /** `repoRoot|KEY` pairs holding different keys in different files (e.g. test vs live). */
  ambiguous: Set<string>;
}

/** Scan + link in one go (used by tests and plain mode). */
export async function discover(
  rt: Runtime,
  roots: string[],
  hosts: string[],
  progress: (msg: string) => void = () => {},
): Promise<Discovery> {
  const d = await scanLocal(rt, roots, progress);
  await linkRemotes(rt, d, hosts, progress);
  return d;
}

/** Finds repos and every key in their env files, for every platform Molly knows. Local only. */
export async function scanLocal(rt: Runtime, roots: string[], progress: (msg: string) => void = () => {}): Promise<Discovery> {
  progress('Finding repos…');
  const repos = await findRepos(roots);
  const detectors = Object.values(rt.registry).filter((p) => p.detect);

  const hits: Hit[] = [];
  for (const repo of repos) {
    for (const file of repo.envFiles) {
      progress(`Reading ${path.relative(repo.root, file) || file} in ${repo.name}`);
      let vars: Map<string, string>;
      try {
        vars = await readDotenv(file);
      } catch {
        continue;
      }
      const claimed = new Set<string>();
      for (const p of detectors) {
        for (const d of p.detect!(vars, file)) {
          if (claimed.has(d.key)) continue; // first (most specific) provider wins
          claimed.add(d.key);
          hits.push({ ...d, file, repo });
        }
      }
    }
  }

  // Same identity = same credential, wherever it lives.
  const groups = new Map<string, Hit[]>();
  for (const h of hits) groups.set(h.identity, [...(groups.get(h.identity) ?? []), h]);

  const usedIds = new Set<string>();
  const ambiguous = new Set<string>();
  // A variable holding different keys in different files of one repo (e.g. test vs live) can't be
  // matched to a single remote secret by name alone.
  const owners = new Map<string, Set<string>>();
  for (const h of hits) {
    const k = `${h.repo.root}|${h.key}`;
    owners.set(k, (owners.get(k) ?? new Set()).add(h.identity));
  }
  for (const [k, ids] of owners) if (ids.size > 1) ambiguous.add(k);
  const drafts: Draft[] = [];
  for (const group of groups.values()) {
    const provider = rt.registry[group[0].provider];
    const primary = group.find((h) => h.field === provider.fields[0]) ?? group[0];
    let id = slug(`${provider.id}-${primary.key}`);
    for (let n = 2; usedIds.has(id); n++) id = slug(`${provider.id}-${primary.key}-${n}`);
    usedIds.add(id);

    const current: Record<string, string> = {};
    const targets: TargetSpec[] = [];
    for (const h of group) {
      current[h.field] = h.current;
      const vars = await readDotenv(h.file);
      targets.push({
        type: 'dotenv',
        key: h.key,
        value: h.template ?? `{{${h.field}}}`,
        repo: h.repo.root,
        path: h.file,
        fingerprint: fingerprint(vars.get(h.key)!),
      });
    }
    const repoNames = [...new Set(group.map((h) => h.repo.name))];
    drafts.push({
      cred: {
        id,
        platform: provider.id,
        label: primary.label,
        params: Object.assign({}, ...group.map((h) => h.params ?? {})),
        targets,
        state: {},
      },
      current,
      repos: repoNames,
      hits: group,
    });
  }
  // Two different keys under the same name (test vs live): label them by the files they live in.
  const dupes = new Set(drafts.map((d) => d.cred.label).filter((l, i, all) => all.indexOf(l) !== i));
  for (const d of drafts) {
    if (!dupes.has(d.cred.label)) continue;
    const files = [...new Set(d.cred.targets.filter((t) => t.type === 'dotenv').map((t) => path.basename(t.path!)))];
    d.cred.label = `${d.cred.label} (${files.join(', ')})`;
  }
  return { repos, drafts, warnings: [], ambiguous };
}

/** Adds GitHub Actions / Vercel targets for each draft, for the hosts the user connected. */
export async function linkRemotes(rt: Runtime, d: Discovery, hosts: string[], progress: (msg: string) => void = () => {}) {
  const caches: Caches = { gh: new Map(), vc: new Map(), ambiguous: d.ambiguous };
  for (const draft of d.drafts) await linkDraft(rt, hosts, draft, d.warnings, progress, caches);
}

interface Caches {
  gh: Map<string, ReturnType<Runtime['remotes']['githubSecrets']>>;
  vc: Map<string, ReturnType<Runtime['remotes']['vercelEnv']>>;
  ambiguous: Set<string>;
}

async function linkDraft(
  rt: Runtime,
  enabled: string[],
  draft: Draft,
  warnings: string[],
  progress: (m: string) => void,
  { gh: ghCache, vc: vcCache, ambiguous }: Caches,
) {
  const { cred, current } = draft;
  for (const h of draft.hits) {
    const isAmbiguous = ambiguous.has(`${h.repo.root}|${h.key}`);
    const template = h.template ?? `{{${h.field}}}`;
    const fileEnv = envOf(h.file);

    if (enabled.includes('github') && h.repo.github) {
      const slugName = h.repo.github;
      progress(`Checking GitHub secrets for ${slugName}`);
      if (!ghCache.has(slugName)) ghCache.set(slugName, rt.remotes.githubSecrets(slugName));
      try {
        const secrets = await ghCache.get(slugName)!;
        const add = (environment?: string) => {
          if (cred.targets.some((t) => t.type === 'github' && t.slug === slugName && t.key === h.key && t.environment === environment)) return;
          cred.targets.push({ type: 'github', key: h.key, value: template, repo: slugName, slug: slugName, environment });
        };
        if (secrets.repo.includes(h.key)) {
          if (!isAmbiguous) add();
          else {
            const w = `Not linked: GitHub ${slugName} repo secret ${h.key} (${h.repo.name} has different ${h.key} values in different files)`;
            if (!warnings.includes(w)) warnings.push(w);
          }
        }
        for (const [env, names] of Object.entries(secrets.environments)) {
          if (!names.includes(h.key)) continue;
          if (fileEnv && normalizeEnv(env) === fileEnv) add(env);
          else {
            const w = `Not linked: GitHub ${slugName} environment "${env}" ${h.key} (can't confirm it matches ${path.basename(h.file)})`;
            if (!warnings.includes(w)) warnings.push(w);
          }
        }
      } catch (err: any) {
        warnings.push(`GitHub ${slugName}: ${err.message}`);
      }
    }

    if (enabled.includes('vercel')) {
      for (const project of h.repo.vercel) {
        const cacheKey = `${project.teamId}/${project.projectId}`;
        progress(`Checking Vercel env for ${project.name}`);
        if (!vcCache.has(cacheKey)) vcCache.set(cacheKey, rt.remotes.vercelEnv(project.projectId, project.teamId));
        try {
          const entries = (await vcCache.get(cacheKey)!).filter((e) => e.key === h.key);
          if (!entries.length) continue;
          let rendered: string | undefined;
          try {
            rendered = renderTemplate(template, current);
          } catch {}
          let ids = entries.filter((e) => e.value !== undefined && e.value === rendered).map((e) => e.id);
          if (!ids.length) {
            const unreadable = entries.filter((e) => e.value === undefined);
            if (unreadable.length === 1 && entries.length === 1 && !isAmbiguous) ids = [unreadable[0].id];
            else if (fileEnv) ids = unreadable.filter((e) => e.target.includes(fileEnv)).map((e) => e.id);
            if (!ids.length && unreadable.length) {
              const w = `Not linked: Vercel ${project.name} ${h.key} (Molly can't read it to confirm which key it holds)`;
              if (!warnings.includes(w)) warnings.push(w);
            }
          }
          if (!ids.length) continue;
          const existing = cred.targets.find((t) => t.type === 'vercel' && t.projectId === project.projectId && t.key === h.key);
          if (existing) existing.envIds = [...new Set([...(existing.envIds ?? []), ...ids])];
          else
            cred.targets.push({
              type: 'vercel',
              key: h.key,
              value: template,
              repo: project.name,
              projectId: project.projectId,
              teamId: project.teamId,
              envIds: ids,
            });
        } catch (err: any) {
          warnings.push(`Vercel ${project.name}: ${err.message}`);
        }
      }
    }
  }
}

function normalizeEnv(name: string): string {
  const n = name.toLowerCase();
  if (/^prod(uction)?$/.test(n)) return 'production';
  if (/^(staging|stage|stg)$/.test(n)) return 'staging';
  if (/^(dev|development)$/.test(n)) return 'development';
  return n;
}
