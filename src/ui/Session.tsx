import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import TextInput from 'ink-text-input';
import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { saveConfig, tildify, type CredentialSpec, type MollyConfig } from '../core/config.js';
import { linkRemotes, scanLocal, type Discovery, type Draft, type RepoInfo } from '../core/discover.js';
import { rollCredential, type RollEvent, type RollOptions, type Step } from '../core/engine.js';
import { suggestFolders } from '../core/folders.js';
import { providerContext, resolveAuthWithSource, type Runtime } from '../core/runtime.js';
import { adoptExisting, mergeConfig } from '../core/setup.js';
import { authKey } from '../core/store.js';
import { plural } from '../core/util.js';
import { CATEGORIES, type Provider, type Question } from '../providers/types.js';
import { describeTarget } from '../targets/types.js';
import { Bar, Busy, c, Card, Chip, Frame, FrameContext, Row, Scroll, Title, type FrameState, type SidebarItem } from './kit.js';
import { useMouseInput } from './mouse.js';

type Phase = 'folder' | 'scan' | 'overview' | 'choose' | 'hosts' | 'link' | 'platform' | 'redeploy' | 'summary';
type Outcome = 'rolled' | 'partial' | 'failed' | 'skipped';
type Results = Record<string, { outcome: Outcome; note?: string; followUps: string[] }>;

const STEP_OF: Record<Phase, number> = { folder: 0, scan: 0, overview: 1, choose: 1, hosts: 2, link: 2, platform: 2, redeploy: 3, summary: 3 };

export interface SessionProps {
  rt: Runtime;
  existing: MollyConfig | null;
  /** Ask for the work folder even if one is saved. */
  askFolder?: boolean;
  /** Pre-set folder (demo). */
  roots?: string[];
  opts: RollOptions;
  openUrl: (url: string) => void;
  onExit: (code: number) => void;
}

const expand = (p: string) => path.resolve(p.trim().replace(/^~(?=$|\/)/, os.homedir()));
const categoryOrder = (p: Provider) => CATEGORIES.findIndex((cat) => cat.id === p.category);
const serviceName = (rt: Runtime, d: Draft) => (d.cred.platform === 'generated' ? d.cred.label : rt.registry[d.cred.platform].name);
const touches = (d: Draft, repo: RepoInfo) => d.hits.some((h) => h.repo === repo);
/** Pads or truncates to exactly `n` columns. */
const fit = (s: string, n: number) => (s.length > n - 1 ? s.slice(0, n - 2) + '… ' : s.padEnd(n));

/** ↑/↓ (and j/k) over `count` items. */
function useCursor(count: number, active = true) {
  const [cursor, setCursor] = useState(0);
  useInput(
    (input, key) => {
      if (!count) return;
      if (key.upArrow || input === 'k') setCursor((i) => (i - 1 + count) % count);
      if (key.downArrow || input === 'j') setCursor((i) => (i + 1) % count);
    },
    { isActive: active },
  );
  return [Math.min(cursor, Math.max(0, count - 1)), setCursor] as const;
}

/** The slice of a long list that fits, keeping `cursor` visible. */
function visible<T>(items: T[], cursor: number, max: number) {
  if (items.length <= max) return { start: 0, items };
  const start = Math.max(0, Math.min(cursor - Math.floor(max / 2), items.length - max));
  return { start, items: items.slice(start, start + max) };
}

export function Session({ rt, existing, askFolder, roots: presetRoots, opts, openUrl, onExit }: SessionProps) {
  const { exit } = useApp();
  const initialRoots = presetRoots ?? (askFolder ? undefined : existing?.roots?.length ? existing.roots : undefined);
  const [phase, setPhase] = useState<Phase>(initialRoots ? 'scan' : 'folder');
  const [roots, setRoots] = useState<string[]>(initialRoots ?? []);
  const [scan, setScan] = useState<Discovery | null>(null);
  const [chosen, setChosen] = useState<Draft[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [results, setResults] = useState<Results>({});
  const [redeploys, setRedeploys] = useState<string[]>([]);
  const config = useRef<MollyConfig | null>(null);
  const touched = useRef(new Map<string, { projectId: string; teamId?: string; name: string }>());

  const quit = (code = 0) => {
    onExit(code);
    exit();
  };
  useInput((input, key) => {
    if (key.ctrl && input === 'c') quit(130);
  });

  const auto = useMemo(() => (scan?.drafts ?? []).filter((d) => rt.registry[d.cred.platform].mode === 'auto'), [scan]);
  const manual = useMemo(() => (scan?.drafts ?? []).filter((d) => rt.registry[d.cred.platform].mode === 'guided'), [scan]);

  const queue = useMemo(() => {
    const by = new Map<string, Draft[]>();
    for (const d of chosen) by.set(d.cred.platform, [...(by.get(d.cred.platform) ?? []), d]);
    return [...by]
      .map(([id, drafts]) => ({ provider: rt.registry[id], drafts }))
      .sort((a, b) => categoryOrder(a.provider) - categoryOrder(b.provider));
  }, [chosen]);

  const neededHosts = useMemo(() => {
    const repos = new Set(chosen.flatMap((d) => d.hits.map((h) => h.repo)));
    const out: string[] = [];
    if ([...repos].some((r) => r.github)) out.push('github');
    if ([...repos].some((r) => r.vercel.length)) out.push('vercel');
    return out;
  }, [chosen]);

  const save = async () => {
    if (config.current) await saveConfig(config.current);
  };

  // Sidebar: repos and platforms with live status.
  const frame: FrameState = useMemo(() => {
    const rotating = phase === 'platform' || phase === 'redeploy' || phase === 'summary';
    const current = phase === 'platform' ? queue[queueIndex]?.provider.id : undefined;
    const statusOf = (drafts: Draft[]): SidebarItem['status'] => {
      if (!drafts.length) return 'info';
      const rs = drafts.map((d) => results[d.cred.id]?.outcome);
      if (drafts.some((d) => d.cred.platform === current) && rs.some((r) => !r)) return 'active';
      if (rs.some((r) => r === 'failed' || r === 'partial')) return 'warn';
      if (rs.every((r) => r === 'rolled')) return 'done';
      if (rs.every((r) => r === 'skipped')) return 'skipped';
      return 'pending';
    };
    const repos = (scan?.repos ?? [])
      .filter((r) => [...auto, ...manual].some((d) => touches(d, r)))
      .map((r) => ({ label: r.name, status: rotating ? statusOf(chosen.filter((d) => touches(d, r))) : ('info' as const) }));
    const platforms = rotating || phase === 'hosts' || phase === 'link'
      ? queue.map((q) => ({ label: q.provider.name, status: statusOf(q.drafts) }))
      : [];
    return {
      step: STEP_OF[phase],
      demo: rt.demo,
      sidebar: [
        { title: 'Repos', items: repos },
        { title: 'Platforms', items: platforms },
      ],
    };
  }, [phase, scan, chosen, queueIndex, results]);

  return (
    <FrameContext.Provider value={frame}>
      {phase === 'folder' && (
        <FolderScreen
          onSubmit={(dir) => {
            setRoots([dir]);
            setPhase('scan');
          }}
          onQuit={() => quit(0)}
        />
      )}

      {phase === 'scan' && (
        <ScanScreen
          rt={rt}
          roots={roots}
          onDone={(d) => {
            adoptExisting(d.drafts, existing);
            setScan(d);
            setPhase('overview');
          }}
        />
      )}

      {phase === 'overview' && scan && (
        <OverviewScreen
          rt={rt}
          scan={scan}
          auto={auto}
          manual={manual}
          roots={roots}
          onAll={() => {
            setChosen(auto);
            setPhase('hosts');
          }}
          onChoose={() => setPhase('choose')}
          onChangeFolder={() => setPhase('folder')}
          onQuit={() => quit(0)}
        />
      )}

      {phase === 'choose' && (
        <ChooseScreen
          rt={rt}
          drafts={auto}
          onSubmit={(ds) => {
            setChosen(ds);
            setPhase('hosts');
          }}
          onBack={() => setPhase('overview')}
        />
      )}

      {phase === 'hosts' && (
        <HostsScreen
          rt={rt}
          needed={neededHosts}
          openUrl={openUrl}
          onDone={(connected) => {
            setHosts(connected);
            setPhase('link');
          }}
        />
      )}

      {phase === 'link' && scan && (
        <LinkScreen
          rt={rt}
          scan={scan}
          hosts={hosts}
          onDone={async () => {
            const platforms = [...new Set([...hosts, ...chosen.map((d) => d.cred.platform)])];
            config.current = mergeConfig(
              existing,
              { platforms, roots, options: existing?.options ?? { redeployVercel: false } },
              chosen.map((d) => d.cred),
            );
            await save();
            setPhase(queue.length ? 'platform' : 'summary');
          }}
        />
      )}

      {phase === 'platform' && queue[queueIndex] && config.current && (
        <PlatformScreen
          key={queue[queueIndex].provider.id}
          rt={rt}
          index={queueIndex}
          total={queue.length}
          provider={queue[queueIndex].provider}
          drafts={queue[queueIndex].drafts}
          config={config.current}
          opts={opts}
          touched={touched.current}
          save={save}
          openUrl={openUrl}
          next={queue[queueIndex + 1]?.provider.name}
          onProgress={(r) => setResults((o) => ({ ...o, ...r }))}
          onDone={(r) => {
            setResults((o) => ({ ...o, ...r }));
            if (queueIndex + 1 < queue.length) setQueueIndex(queueIndex + 1);
            else setPhase(touched.current.size ? 'redeploy' : 'summary');
          }}
        />
      )}

      {phase === 'redeploy' && (
        <RedeployScreen
          rt={rt}
          projects={[...touched.current.values()]}
          onDone={(lines) => {
            setRedeploys(lines);
            setPhase('summary');
          }}
        />
      )}

      {phase === 'summary' && scan && (
        <SummaryScreen
          rt={rt}
          scan={scan}
          chosen={chosen}
          manual={manual}
          results={results}
          redeploys={redeploys}
          onExit={() => quit(Object.values(results).some((o) => o.outcome === 'failed' || o.outcome === 'partial') ? 1 : 0)}
        />
      )}
    </FrameContext.Provider>
  );
}

// ─── 1. Folder ─────────────────────────────────────────────────────────────

function FolderScreen({ onSubmit, onQuit }: { onSubmit: (dir: string) => void; onQuit: () => void }) {
  const [options, setOptions] = useState<{ dir: string; repos: number }[] | null>(null);
  const [typing, setTyping] = useState(false);
  const [value, setValue] = useState('~/');
  const rows = options ? [...options.slice(0, 8), { dir: '', repos: 0 }] : [];
  const [cursor, setCursor] = useCursor(rows.length, !typing);

  useEffect(() => {
    suggestFolders([process.cwd()]).then((s) => {
      setOptions(s);
      if (!s.length) setTyping(true);
    });
  }, []);

  const pick = (i: number) => (rows[i].dir ? onSubmit(rows[i].dir) : setTyping(true));
  const submitTyped = () => value.trim() && onSubmit(expand(value));

  return (
    <Frame
      typing={typing}
      buttons={[
        { label: typing ? 'Scan this folder' : 'Choose', primary: true, onPress: () => (typing ? submitTyped() : pick(cursor)) },
        ...(typing && options?.length ? [{ label: 'Back', hotkey: 'esc', onPress: () => setTyping(false) }] : []),
        { label: 'Quit', hotkey: typing ? undefined : 'q', onPress: onQuit },
      ]}
    >
      <Title sub="Molly looks through it for git repos and the API keys they use. Nothing changes until you say so.">
        Where do you keep your repos?
      </Title>
      {!options ? (
        <Busy label="Looking for folders with git repos…" />
      ) : typing ? (
        <Card title="Folder path">
          <Box>
            <Text color={c.brand}>❯ </Text>
            <TextInput value={value} onChange={setValue} onSubmit={submitTyped} />
          </Box>
        </Card>
      ) : (
        <Box flexDirection="column">
          {rows.map((o, i) => (
            <Row key={o.dir || 'other'} active={i === cursor} onClick={() => (setCursor(i), pick(i))}>
              {o.dir ? (
                <Text>
                  <Text bold={i === cursor}>{fit(tildify(o.dir), 40)}</Text>
                  <Text color={c.dim}>{plural(o.repos, 'repo')}</Text>
                  {i === 0 ? <Text color={c.ok}>  suggested</Text> : null}
                </Text>
              ) : (
                <Text color={i === cursor ? undefined : c.dim}>Another folder…</Text>
              )}
            </Row>
          ))}
        </Box>
      )}
    </Frame>
  );
}

function ScanScreen({ rt, roots, onDone }: { rt: Runtime; roots: string[]; onDone: (d: Discovery) => void }) {
  const [msg, setMsg] = useState(`Scanning ${roots.map(tildify).join(', ')}…`);
  useEffect(() => {
    scanLocal(rt, roots, setMsg).then(onDone);
  }, []);
  return (
    <Frame>
      <Title sub={roots.map(tildify).join(', ')}>Scanning your repos</Title>
      <Busy label={msg} />
    </Frame>
  );
}

// ─── 2. What each repo uses ────────────────────────────────────────────────

function OverviewScreen({
  rt,
  scan,
  auto,
  manual,
  roots,
  onAll,
  onChoose,
  onChangeFolder,
  onQuit,
}: {
  rt: Runtime;
  scan: Discovery;
  auto: Draft[];
  manual: Draft[];
  roots: string[];
  onAll: () => void;
  onChoose: () => void;
  onChangeFolder: () => void;
  onQuit: () => void;
}) {
  const { rows: height } = useWindowSize();
  const rows = scan.repos
    .map((repo) => ({
      repo,
      rotatable: [...new Set(auto.filter((d) => touches(d, repo)).map((d) => serviceName(rt, d)))],
      manualOnly: [...new Set(manual.filter((d) => touches(d, repo)).map((d) => serviceName(rt, d)))],
      where: [repo.github && 'GitHub', repo.vercel.length && 'Vercel'].filter(Boolean) as string[],
    }))
    .filter((r) => r.rotatable.length || r.manualOnly.length)
    .sort((a, b) => b.rotatable.length - a.rotatable.length);
  const [offset, setOffset] = useState(0);
  const max = Math.max(3, height - 16);
  const shown = rows.slice(offset, offset + max);
  const scroll = (d: number) => setOffset((o) => Math.max(0, Math.min(rows.length - max, o + d)));
  useInput((_i, key) => {
    if (key.downArrow) scroll(1);
    if (key.upArrow) scroll(-1);
  });
  const nameW = Math.min(26, Math.max(10, ...rows.map((r) => r.repo.name.length)) + 2);
  const services = new Set([...auto, ...manual].map((d) => serviceName(rt, d))).size;
  const repoCount = new Set(auto.flatMap((d) => d.hits.map((h) => h.repo.root))).size;

  if (!rows.length) {
    return (
      <Frame
        buttons={[
          { label: 'Choose another folder', primary: true, onPress: onChangeFolder },
          { label: 'Quit', hotkey: 'q', onPress: onQuit },
        ]}
      >
        <Title sub="Molly looks in .env, .env.local, .env.production and .dev.vars files (not .env.example).">
          No API keys found in {tildify(roots[0])}
        </Title>
      </Frame>
    );
  }

  return (
    <Frame
      buttons={[
        ...(auto.length ? [{ label: `Rotate ${plural(auto.length, 'key')}`, primary: true, onPress: onAll }] : []),
        ...(auto.length > 1 ? [{ label: 'Choose keys', hotkey: 'c', onPress: onChoose }] : []),
        { label: 'Change folder', hotkey: 'f', onPress: onChangeFolder },
        { label: 'Quit', hotkey: 'q', onPress: onQuit },
      ]}
    >
      <Title sub={`Found in each repo's env files. Molly rotates the green ones through each platform's API, ${repoCount ? `across ${plural(repoCount, 'repo')}` : ''}.`}>
        {plural(rows.length, 'repo')} use {plural(services, 'service')}
      </Title>
      <Scroll onScroll={scroll}>
        {shown.map(({ repo, rotatable, manualOnly, where }) => (
          <Box key={repo.root} marginBottom={1}>
            <Box width={nameW} flexShrink={0}>
              <Text bold wrap="truncate-end">
                {repo.name}
              </Text>
            </Box>
            <Box flexGrow={1} flexWrap="wrap">
              {rotatable.map((s) => (
                <Chip key={s} label={s} />
              ))}
              {manualOnly.map((s) => (
                <Chip key={s} label={`${s}*`} tone="dim" />
              ))}
            </Box>
            {where.length ? (
              <Box flexShrink={0}>
                <Text color={c.accent}>→ {where.join(' · ')}</Text>
              </Box>
            ) : null}
          </Box>
        ))}
        {rows.length > max ? (
          <Text color={c.dim}>
            {offset + shown.length} of {rows.length} repos · scroll for more
          </Text>
        ) : null}
      </Scroll>
      <Box flexDirection="column">
        {scan.repos.length > rows.length ? <Text color={c.dim}>{plural(scan.repos.length - rows.length, 'other repo')} had no keys.</Text> : null}
        {manual.length ? (
          <Text color={c.dim}>
            * {[...new Set(manual.map((d) => rt.registry[d.cred.platform].name))].join(', ')} have no rotation API, so Molly can't rotate them. You'll get links at the end.
          </Text>
        ) : null}
      </Box>
    </Frame>
  );
}

function ChooseScreen({ rt, drafts, onSubmit, onBack }: { rt: Runtime; drafts: Draft[]; onSubmit: (d: Draft[]) => void; onBack: () => void }) {
  const { rows: height } = useWindowSize();
  const [selected, setSelected] = useState(() => new Set(drafts.map((d) => d.cred.id)));
  const [cursor, setCursor] = useCursor(drafts.length);
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  useInput((input) => {
    if (input === ' ') toggle(drafts[cursor].cred.id);
  });
  const view = visible(drafts, cursor, Math.max(4, height - 12));
  const picked = drafts.filter((d) => selected.has(d.cred.id));
  return (
    <Frame
      buttons={[
        { label: `Rotate ${plural(picked.length, 'key')}`, primary: true, disabled: !picked.length, onPress: () => onSubmit(picked) },
        {
          label: selected.size === drafts.length ? 'Select none' : 'Select all',
          hotkey: 'a',
          onPress: () => setSelected(selected.size === drafts.length ? new Set() : new Set(drafts.map((d) => d.cred.id))),
        },
        { label: 'Back', hotkey: 'b', onPress: onBack },
      ]}
      hint="space or click to toggle"
    >
      <Title sub="Everything is selected. Untick anything you want to leave alone.">Which keys should Molly rotate?</Title>
      {view.items.map((d, i) => {
        const on = selected.has(d.cred.id);
        const idx = view.start + i;
        return (
          <Row key={d.cred.id} active={idx === cursor} onClick={() => (setCursor(idx), toggle(d.cred.id))}>
            <Text wrap="truncate-end">
              <Text color={on ? c.ok : c.dim}>{on ? '☑' : '☐'}</Text> <Text bold>{rt.registry[d.cred.platform].name.padEnd(19)}</Text>
              {fit(d.cred.label, 30)}
              <Text color={c.dim}>
                {plural(d.cred.targets.length, 'place')} · {d.repos.join(', ')}
              </Text>
            </Text>
          </Row>
        );
      })}
    </Frame>
  );
}

// ─── Logging in ────────────────────────────────────────────────────────────

/**
 * Makes sure Molly can talk to a platform: reuses existing logins, runs the platform's own browser
 * login when its CLI is installed, and only falls back to asking for an admin key.
 */
function AuthGate({
  rt,
  provider,
  why,
  header,
  openUrl,
  onDone,
}: {
  rt: Runtime;
  provider: Provider;
  why: string;
  header?: React.ReactNode;
  openUrl: (u: string) => void;
  onDone: (ok: boolean, label?: string) => void;
}) {
  const { suspendTerminal } = useApp();
  const mouse = useMouseInput();
  const required = (provider.auth ?? []).filter((f) => !f.optional);
  const [mode, setMode] = useState<'checking' | 'login' | 'paste'>('checking');
  const [cli, setCli] = useState(false);
  const [error, setError] = useState('');
  const [fieldIdx, setFieldIdx] = useState(0);
  const [value, setValue] = useState('');
  const entered = useRef<Record<string, string>>({});
  const opened = useRef(false);

  const check = async () => {
    setMode('checking');
    const missing = [];
    for (const f of required) if (!entered.current[f.key] && !(await resolveAuthWithSource(rt, provider.id, f.key))) missing.push(f);
    if (!missing.length) {
      const ctx = providerContext(rt, provider);
      const base = { ...ctx };
      ctx.auth = async (f) => entered.current[f] ?? base.auth(f);
      ctx.authOptional = async (f) => entered.current[f] ?? base.authOptional(f);
      try {
        const label = provider.checkAuth ? await provider.checkAuth(ctx) : undefined;
        for (const [k, v] of Object.entries(entered.current)) await rt.store.set(authKey(provider.id, k), v);
        return onDone(true, label);
      } catch (err: any) {
        const pasted = Object.keys(entered.current).length > 0;
        entered.current = {};
        setError(pasted ? `That didn't work: ${err.message}` : `Your saved login didn't work: ${err.message}`);
      }
    }
    const hasCli = !!provider.cliLogin && (await provider.cliLogin.available());
    setCli(hasCli);
    if (hasCli) setMode('login');
    else startPaste();
  };

  const startPaste = () => {
    if (!required.length) {
      setError((e) => e || `Log in to ${provider.name} in another terminal, then check again.`);
      setMode('login');
      return;
    }
    setFieldIdx(0);
    setValue('');
    setMode('paste');
    if (provider.loginUrl && !opened.current && !rt.demo) {
      opened.current = true;
      openUrl(provider.loginUrl);
    }
  };

  const browserLogin = async () => {
    mouse?.stop();
    await suspendTerminal(() => provider.cliLogin!.run());
    mouse?.start();
    void check();
  };

  const submitField = () => {
    const field = required[fieldIdx];
    if (!value.trim()) return;
    entered.current[field.key] = value.trim();
    setValue('');
    setError('');
    if (fieldIdx + 1 < required.length) setFieldIdx(fieldIdx + 1);
    else void check();
  };

  useEffect(() => {
    void check();
  }, []);
  usePaste((text) => setValue((v) => v + text.trim()), { isActive: mode === 'paste' });

  const field = required[fieldIdx];
  const buttons =
    mode === 'checking'
      ? []
      : mode === 'login'
        ? [
            { label: cli ? `Log in with ${provider.cliLogin!.label}` : 'Check again', primary: true, onPress: cli ? browserLogin : check },
            ...(cli && required.length ? [{ label: 'Use an API key', hotkey: 'k', onPress: startPaste }] : []),
            { label: `Skip ${provider.name}`, hotkey: 's', onPress: () => onDone(false) },
          ]
        : [
            { label: 'Connect', primary: true, onPress: submitField },
            ...(provider.loginUrl ? [{ label: 'Open page again', onPress: () => openUrl(provider.loginUrl!) }] : []),
            { label: `Skip ${provider.name}`, hotkey: 'esc', onPress: () => onDone(false) },
          ];

  return (
    <Frame buttons={buttons} typing={mode === 'paste'}>
      {header}
      {mode === 'checking' ? (
        <Busy label={`Connecting to ${provider.name}…`} />
      ) : (
        <Card title={`Log in to ${provider.name}`} right={why}>
          {error ? (
            <Box marginBottom={1}>
              <Text color={c.warn}>{error}</Text>
            </Box>
          ) : null}
          {mode === 'login' ? (
            <Text>
              {cli
                ? `Molly will open the ${provider.cliLogin!.label} login in your browser. Approve it there, then come back here.`
                : `Molly couldn't find a ${provider.name} login.`}
            </Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                {provider.name} doesn't offer a browser login for tools, so Molly needs a <Text bold>{field.label}</Text>. You only do this once.
              </Text>
              {provider.loginUrl ? (
                <Text color={c.dim}>
                  {rt.demo ? 'Create one at ' : 'Opened '}
                  {provider.loginUrl} in your browser.
                </Text>
              ) : null}
              {field.help ? <Text color={c.dim}>{field.help}</Text> : null}
              <Box marginTop={1} borderStyle="round" borderColor={c.dim} paddingX={1}>
                <Text color={c.brand}>❯ </Text>
                <TextInput value={value} mask={field.secret ? '•' : undefined} placeholder="paste it here" onChange={setValue} onSubmit={submitField} />
              </Box>
              <Text color={c.dim}>Stored in your macOS keychain. Molly only uses it to create and revoke keys.</Text>
            </Box>
          )}
        </Card>
      )}
    </Frame>
  );
}

function HostsScreen({ rt, needed, openUrl, onDone }: { rt: Runtime; needed: string[]; openUrl: (u: string) => void; onDone: (connected: string[]) => void }) {
  const [i, setI] = useState(0);
  const connected = useRef<string[]>([]);
  const [lines, setLines] = useState<{ ok: boolean; text: string }[]>([]);
  useEffect(() => {
    if (i >= needed.length) onDone(connected.current);
  }, [i]);
  const host = rt.registry[needed[i]];
  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Title sub="Your repos also keep secrets here. Connecting lets Molly update them in the same pass.">Connect where your secrets live</Title>
      {lines.map((l) => (
        <Text key={l.text}>
          <Text color={l.ok ? c.ok : c.dim}>{l.ok ? '✓' : '–'}</Text> {l.text}
        </Text>
      ))}
    </Box>
  );
  if (!host)
    return (
      <Frame>
        {header}
        <Busy label="Continuing…" />
      </Frame>
    );
  return (
    <AuthGate
      key={host.id}
      rt={rt}
      provider={host}
      header={header}
      openUrl={openUrl}
      why={host.id === 'github' ? 'to update Actions secrets' : 'to update env vars'}
      onDone={(ok, label) => {
        if (ok) connected.current.push(host.id);
        setLines((l) => [...l, ok ? { ok, text: `${host.name}${label ? `  ${label}` : ''}` } : { ok, text: `${host.name} skipped: only local files will be updated` }]);
        setI(i + 1);
      }}
    />
  );
}

function LinkScreen({ rt, scan, hosts, onDone }: { rt: Runtime; scan: Discovery; hosts: string[]; onDone: () => void }) {
  const [msg, setMsg] = useState('Finding where each key is used…');
  useEffect(() => {
    linkRemotes(rt, scan, hosts, setMsg).then(onDone);
  }, []);
  return (
    <Frame>
      <Title sub="Matching your keys to GitHub secrets and Vercel env vars">Getting ready</Title>
      <Busy label={msg} />
    </Frame>
  );
}

// ─── 3. One platform at a time ─────────────────────────────────────────────

interface CredView {
  status: 'pending' | 'active' | Outcome;
  step?: Step;
  seen: Step[];
  targets: Record<number, { status: 'ok' | 'error' | 'skipped'; message?: string }>;
  message?: string;
  followUps: string[];
}

const PIPELINE: { label: string; steps: Step[] }[] = [
  { label: 'Create', steps: ['resolve', 'issue'] },
  { label: 'Check', steps: ['verify'] },
  { label: 'Update', steps: ['propagate'] },
  { label: 'Revoke', steps: ['revoke'] },
];

function PlatformScreen({
  rt,
  index,
  total,
  provider,
  drafts,
  config,
  opts,
  touched,
  save,
  openUrl,
  next,
  onProgress,
  onDone,
}: {
  rt: Runtime;
  index: number;
  total: number;
  provider: Provider;
  drafts: Draft[];
  config: MollyConfig;
  opts: RollOptions;
  touched: Map<string, { projectId: string; teamId?: string; name: string }>;
  save: () => Promise<void>;
  openUrl: (u: string) => void;
  next?: string;
  onProgress: (r: Results) => void;
  onDone: (r: Results) => void;
}) {
  const { rows: height } = useWindowSize();
  const [mode, setMode] = useState<'auth' | 'prepare' | 'question' | 'rotate' | 'result'>(provider.auth?.length ? 'auth' : 'prepare');
  const [account, setAccount] = useState<string>();
  const [questions, setQuestions] = useState<{ cred: CredentialSpec; q: Question }[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [views, setViews] = useState<Record<string, CredView>>(() =>
    Object.fromEntries(drafts.map((d) => [d.cred.id, { status: 'pending', seen: [], targets: {}, followUps: [] }])),
  );
  const prepFailures = useRef<Record<string, string>>({});
  const q = questions[qIndex];
  const [qCursor, setQCursor] = useCursor(q?.q.options.length ?? 0, mode === 'question');

  const resultsFrom = (v: Record<string, CredView>): Results =>
    Object.fromEntries(
      drafts.map((d) => {
        const s = v[d.cred.id];
        const outcome: Outcome = s.status === 'pending' || s.status === 'active' ? 'skipped' : s.status;
        return [d.cred.id, { outcome, note: s.message, followUps: s.followUps }];
      }),
    );

  useEffect(() => {
    if (mode !== 'prepare') return;
    (async () => {
      const qs: { cred: CredentialSpec; q: Question }[] = [];
      for (const d of drafts) {
        try {
          const asked = (await provider.prepare?.(providerContext(rt, provider, d.cred.params), d.cred, d.current)) ?? [];
          for (const q of asked) qs.push({ cred: d.cred, q });
        } catch (err: any) {
          prepFailures.current[d.cred.id] = err.message;
        }
      }
      await save();
      setQuestions(qs);
      setMode(qs.length ? 'question' : 'rotate');
    })();
  }, [mode]);

  useEffect(() => {
    if (mode !== 'rotate') return;
    (async () => {
      let latest = views;
      const update = (fn: (v: Record<string, CredView>) => Record<string, CredView>) => {
        latest = fn(latest);
        setViews(latest);
      };
      for (const d of drafts) {
        if (prepFailures.current[d.cred.id]) {
          update((v) => ({ ...v, [d.cred.id]: { ...v[d.cred.id], status: 'failed', message: prepFailures.current[d.cred.id] } }));
          continue;
        }
        await rollCredential(rt, config, d.cred, { emit: (e) => update((v) => applyEvent(v, e)), prompt: async () => null }, opts, touched, save);
        onProgress(resultsFrom(latest));
      }
      setMode('result');
    })();
  }, [mode]);

  const answer = (value: string) => {
    q.cred.params[q.q.param] = value;
    if (qIndex + 1 < questions.length) setQIndex(qIndex + 1);
    else void save().then(() => setMode('rotate'));
  };

  const places = drafts.reduce((n, d) => n + d.cred.targets.length, 0);
  const repos = [...new Set(drafts.flatMap((d) => d.repos))];
  const header = (
    <Box justifyContent="space-between" marginBottom={1}>
      <Box flexDirection="column">
        <Text bold color={c.brand}>
          {provider.name}
        </Text>
        <Text color={c.dim}>
          {plural(drafts.length, 'key')} · {plural(places, 'place')} · {repos.join(', ')}
          {account ? ` · ${account}` : ''}
        </Text>
      </Box>
      <Text color={c.dim}>
        platform {index + 1} of {total}
      </Text>
    </Box>
  );

  if (mode === 'auth') {
    return (
      <AuthGate
        rt={rt}
        provider={provider}
        header={header}
        openUrl={openUrl}
        why="to create the new key and revoke the old one"
        onDone={(ok, label) => {
          if (!ok) return onDone(Object.fromEntries(drafts.map((d) => [d.cred.id, { outcome: 'skipped' as Outcome, note: 'skipped (not logged in)', followUps: [] }])));
          setAccount(label);
          setMode('prepare');
        }}
      />
    );
  }

  if (mode === 'prepare') {
    return (
      <Frame>
        {header}
        <Busy label={`Looking up your ${provider.name} account…`} />
      </Frame>
    );
  }

  if (mode === 'question' && q) {
    return (
      <Frame buttons={[{ label: 'Choose', primary: true, onPress: () => answer(q.q.options[qCursor].value) }]}>
        {header}
        <Title>{q.q.prompt}</Title>
        {q.q.options.map((o, i) => (
          <Row key={o.value} active={i === qCursor} onClick={() => (setQCursor(i), answer(o.value))}>
            <Text bold={i === qCursor}>{o.label}</Text>
          </Row>
        ))}
      </Frame>
    );
  }

  const done = mode === 'result';
  const allOk = drafts.every((d) => views[d.cred.id].status === 'rolled');
  const followUps = drafts.flatMap((d) => views[d.cred.id].followUps);
  const revoked = drafts.some((d) => views[d.cred.id].seen.includes('revoke'));
  const budget = Math.max(3, height - 18 - drafts.length * 3);

  return (
    <Frame
      buttons={done ? [{ label: next ? `Next: ${next} →` : 'See summary →', primary: true, onPress: () => onDone(resultsFrom(views)) }] : []}
      hint={done ? undefined : 'working…'}
    >
      {header}
      {done ? (
        <Box marginBottom={1} flexDirection="column">
          <Card tone={allOk ? 'ok' : 'warn'}>
            <Text bold color={allOk ? c.ok : c.warn}>
              {allOk ? `✓ ${provider.name} rotated` : `◐ ${provider.name} needs attention`}
            </Text>
            {allOk ? (
              <Text color={c.dim}>
                {drafts.length === 1 ? 'New key' : `${drafts.length} new keys`} in {plural(places, 'place')}
                {revoked ? ' · old key revoked' : ''}
              </Text>
            ) : null}
            {followUps.map((f, i) => (
              <Text key={i} color={c.warn}>
                • {f}
              </Text>
            ))}
          </Card>
        </Box>
      ) : null}
      {drafts.map((d) => (
        <CredCard key={d.cred.id} cred={d.cred} view={views[d.cred.id]} compact={done && views[d.cred.id].status === 'rolled'} budget={budget} />
      ))}
    </Frame>
  );
}

function applyEvent(v: Record<string, CredView>, e: RollEvent): Record<string, CredView> {
  if (e.type === 'redeploy') return v;
  const cur = v[e.id];
  switch (e.type) {
    case 'cred-start':
      return { ...v, [e.id]: { ...cur, status: 'active' } };
    case 'step':
      return { ...v, [e.id]: { ...cur, step: e.step, seen: [...cur.seen, e.step] } };
    case 'target':
      return { ...v, [e.id]: { ...cur, targets: { ...cur.targets, [e.index]: { status: e.status, message: e.message } } } };
    case 'cred-done':
      return { ...v, [e.id]: { ...cur, status: e.status, message: e.message, followUps: e.followUps } };
  }
}

function CredCard({ cred, view, compact, budget }: { cred: CredentialSpec; view: CredView; compact: boolean; budget: number }) {
  const total = cred.targets.length;
  const ok = Object.values(view.targets).filter((t) => t.status === 'ok').length;
  const icon = { pending: '○', active: '◉', rolled: '✓', partial: '◐', failed: '✗', skipped: '–' }[view.status];
  const tint = { pending: c.dim, active: c.brand, rolled: c.ok, partial: c.warn, failed: c.err, skipped: c.dim }[view.status];

  if (compact || view.status === 'pending' || view.status === 'skipped') {
    return (
      <Text>
        <Text color={tint}>{icon}</Text> <Text bold>{cred.label}</Text>
        <Text color={c.dim}>  {view.status === 'rolled' ? `${plural(total, 'place')} updated` : view.status === 'pending' ? 'waiting' : view.message ?? ''}</Text>
      </Text>
    );
  }

  const stage = PIPELINE.findIndex((p) => view.step && p.steps.includes(view.step));
  const finished = view.status !== 'active';
  const targets = cred.targets.map((t, i) => ({ t, s: view.targets[i] }));
  const failedFirst = [...targets.filter((x) => x.s?.status === 'error'), ...targets.filter((x) => x.s?.status !== 'error')];
  const shown = failedFirst.slice(0, budget);

  return (
    <Box marginBottom={1} flexDirection="column">
      <Card tone={view.status === 'failed' ? 'warn' : view.status === 'partial' ? 'warn' : 'brand'} title={cred.label} right={finished ? undefined : 'working…'}>
        <Text>
          {PIPELINE.map((p, i) => {
            const state = finished ? (view.seen.some((s) => p.steps.includes(s)) ? 'done' : 'skip') : i < stage ? 'done' : i === stage ? 'now' : 'todo';
            return (
              <Text key={p.label}>
                {i ? <Text color={c.dim}> ─ </Text> : null}
                <Text color={state === 'done' ? c.ok : state === 'now' ? c.brand : c.dim}>{state === 'done' ? '●' : state === 'now' ? '◉' : '○'}</Text>{' '}
                <Text color={state === 'todo' || state === 'skip' ? c.dim : undefined} bold={state === 'now'}>
                  {p.label}
                </Text>
              </Text>
            );
          })}
        </Text>
        {view.status === 'failed' ? (
          <Text color={c.err}>{view.message}</Text>
        ) : (
          <Box marginTop={1} flexDirection="column">
            <Bar value={ok} total={total} />
            {shown.map(({ t, s }, i) => (
              <Text key={i} color={s?.status === 'error' ? c.err : c.dim} wrap="truncate-end">
                {s ? s.status === 'ok' ? <Text color={c.ok}>✓</Text> : '✗' : '·'} {tildify(describeTarget(t))}  {t.key}
                {s?.message ? `: ${s.message}` : ''}
              </Text>
            ))}
            {targets.length > shown.length ? <Text color={c.dim}>  +{targets.length - shown.length} more</Text> : null}
            {view.status === 'partial' && view.message ? <Text color={c.warn}>{view.message}</Text> : null}
          </Box>
        )}
      </Card>
    </Box>
  );
}

// ─── 4. Wrap up ────────────────────────────────────────────────────────────

function RedeployScreen({
  rt,
  projects,
  onDone,
}: {
  rt: Runtime;
  projects: { projectId: string; teamId?: string; name: string }[];
  onDone: (lines: string[]) => void;
}) {
  const [running, setRunning] = useState(false);
  const run = async (yes: boolean) => {
    if (!yes) return onDone(projects.map((p) => `↻ Vercel ${p.name}: redeploy to pick up the new keys`));
    setRunning(true);
    const lines: string[] = [];
    for (const p of projects) {
      try {
        lines.push(`✓ Vercel ${p.name}: redeploying → ${await rt.remotes.vercelRedeploy(p.projectId, p.teamId)}`);
      } catch (err: any) {
        lines.push(`✗ Vercel ${p.name}: ${err.message}`);
      }
    }
    onDone(lines);
  };
  return (
    <Frame
      buttons={
        running
          ? []
          : [
              { label: 'Redeploy now', primary: true, onPress: () => void run(true) },
              { label: 'Not now', hotkey: 'n', onPress: () => void run(false) },
            ]
      }
    >
      <Title sub="Vercel only picks up new env values on the next deployment.">Redeploy on Vercel?</Title>
      {running ? (
        <Busy label="Redeploying…" />
      ) : (
        <Card title="Production deployments">
          {projects.map((p) => (
            <Text key={p.projectId}>• {p.name}</Text>
          ))}
        </Card>
      )}
    </Frame>
  );
}

function SummaryScreen({
  rt,
  scan,
  chosen,
  manual,
  results,
  redeploys,
  onExit,
}: {
  rt: Runtime;
  scan: Discovery;
  chosen: Draft[];
  manual: Draft[];
  results: Results;
  redeploys: string[];
  onExit: () => void;
}) {
  const rolled = Object.values(results).filter((o) => o.outcome === 'rolled').length;
  const repos = scan.repos.filter((r) => [...chosen, ...manual].some((d) => touches(d, r)));
  const nameW = Math.min(26, Math.max(10, ...repos.map((r) => r.name.length)) + 2);
  const followUps = chosen.flatMap((d) => (results[d.cred.id]?.followUps ?? []).map((f) => `${serviceName(rt, d)}: ${f}`));
  const problems = chosen.filter((d) => ['failed', 'partial'].includes(results[d.cred.id]?.outcome));
  const tone = { rolled: 'ok', partial: 'warn', failed: 'err', skipped: 'dim' } as const;
  const mark = { rolled: '✓', partial: '◐', failed: '✗', skipped: '–' } as const;

  return (
    <Frame buttons={[{ label: 'Done', primary: true, onPress: onExit }]}>
      <Title sub="Next time, just run molly. Your folder and logins are saved, so it goes straight to rotating.">
        {problems.length ? '◐' : '✓'} Rotated {rolled} of {plural(chosen.length, 'key')}
      </Title>
      {repos.map((repo) => (
        <Box key={repo.root} marginBottom={1}>
          <Box width={nameW} flexShrink={0}>
            <Text bold wrap="truncate-end">
              {repo.name}
            </Text>
          </Box>
          <Box flexGrow={1} flexWrap="wrap">
            {chosen
              .filter((d) => touches(d, repo))
              .map((d) => {
                const o = results[d.cred.id]?.outcome ?? 'skipped';
                return <Chip key={d.cred.id} label={`${mark[o]} ${serviceName(rt, d)}`} tone={tone[o]} />;
              })}
            {[...new Set(manual.filter((d) => touches(d, repo)).map((d) => serviceName(rt, d)))].map((s) => (
              <Chip key={s} label={`○ ${s}`} tone="dim" />
            ))}
          </Box>
        </Box>
      ))}
      {redeploys.map((l) => (
        <Text key={l}>{l}</Text>
      ))}
      {problems.map((d) => (
        <Text key={d.cred.id} color={c.warn}>
          • {serviceName(rt, d)} {d.cred.label}: {results[d.cred.id].note}
        </Text>
      ))}
      {followUps.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Left for you</Text>
          {followUps.map((f, i) => (
            <Text key={i} color={c.dim}>
              • {f}
            </Text>
          ))}
        </Box>
      ) : null}
      {manual.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Rotate these in their dashboards (no API)</Text>
          {[...new Set(manual.map((d) => d.cred.platform))].map((id) => (
            <Text key={id} color={c.dim} wrap="truncate-end">
              ○ {rt.registry[id].name}  <Text color={c.accent}>{rt.registry[id].dashboardUrl}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Frame>
  );
}
