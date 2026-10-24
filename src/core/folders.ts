import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMON = ['Code', 'code', 'Projects', 'projects', 'Developer', 'dev', 'Dev', 'src', 'repos', 'workspace', 'git', 'GitHub',
  'Documents/Code', 'Documents/Projects', 'Documents/GitHub', 'Documents/Developer', 'Sites'];

/** Counts git repos up to two levels down (enough to rank candidate folders quickly). */
export async function countRepos(dir: string, depth = 2): Promise<number> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  if (entries.some((e) => e.name === '.git')) return 1;
  if (depth === 0) return 0;
  let n = 0;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') n += await countRepos(path.join(dir, e.name), depth - 1);
  }
  return n;
}

/** Likely "main work folders" on this machine, most repos first. */
export async function suggestFolders(extra: string[] = []): Promise<{ dir: string; repos: number }[]> {
  const home = os.homedir();
  const candidates = [...new Set([...extra, ...COMMON.map((c) => path.join(home, c))])];
  const seen = new Set<string>();
  const out: { dir: string; repos: number }[] = [];
  for (const dir of candidates) {
    let real: string;
    try {
      real = await fs.realpath(dir); // also de-dupes case-insensitive matches like Code/code
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const repos = await countRepos(dir);
    if (repos) out.push({ dir, repos });
  }
  return out.sort((a, b) => b.repos - a.repos);
}
