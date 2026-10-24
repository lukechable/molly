import { Box, Text, useApp, useInput, usePaste } from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import os from 'node:os';
import path from 'node:path';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { saveConfig, tildify, type CredentialSpec, type MollyConfig } from '../core/config.js';
import { linkRemotes, scanLocal, type Discovery, type Draft } from '../core/discover.js';
import { rollCredential, type RollEvent, type RollOptions, type Step } from '../core/engine.js';
import { suggestFolders } from '../core/folders.js';
import { providerContext, resolveAuthWithSource, type Runtime } from '../core/runtime.js';
import { adoptExisting, mergeConfig } from '../core/setup.js';
import { authKey } from '../core/store.js';
import { plural } from '../core/util.js';
import { CATEGORIES, type Provider, type Question } from '../providers/types.js';
import { describeTarget } from '../targets/types.js';
import { color, Confirm, GroupedMultiSelect, Header, Hints, Select, Working } from './components.js';

type Phase = 'folder' | 'scan' | 'overview' | 'choose' | 'hosts' | 'link' | 'platform' | 'redeploy' | 'summary';
type Outcome = 'rolled' | 'partial' | 'failed' | 'skipped';

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
const categoryOrder = (p: Provider) => CATEGORIES.findIndex((c) => c.id === p.category);
const serviceName = (rt: Runtime, d: Draft) => (d.cred.platform === 'generated' ? d.cred.label : rt.registry[d.cred.platform].name);

export function Session({ rt, existing, askFolder, roots: presetRoots, opts, openUrl, onExit }: SessionProps) {
  const { exit } = useApp();
  const initialRoots = presetRoots ?? (askFolder ? undefined : existing?.roots?.length ? existing.roots : undefined);
  const [phase, setPhase] = useState<Phase>(initialRoots ? 'scan' : 'folder');
  const [roots, setRoots] = useState<string[]>(initialRoots ?? []);
  const [scan, setScan] = useState<Discovery | null>(null);
  const [chosen, setChosen] = useState<Draft[]>([]);
  const [hosts, setHosts] = useState<string[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, { outcome: Outcome; note?: string; followUps: string[] }>>({});
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

  // One step per platform, in a stable order.
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

  const startRotating = (drafts: Draft[]) => {
    setChosen(drafts);
    setPhase('hosts');
  };

  const subtitle = rt.demo ? 'demo · fake repos, fake keys' : undefined;
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header subtitle={subtitle} />

      {phase === 'folder' && (
        <FolderStep
          onSubmit={(dir) => {
            setRoots([dir]);
            setPhase('scan');
          }}
        />
      )}

      {phase === 'scan' && (
        <ScanStep
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
        <Overview
          rt={rt}
          scan={scan}
          auto={auto}
          manual={manual}
          roots={roots}
          onAll={() => startRotating(auto)}
          onChoose={() => setPhase('choose')}
          onQuit={() => quit(0)}
        />
      )}

      {phase === 'choose' && (
        <Box flexDirection="column">
          <Text bold>Which keys should Molly rotate?</Text>
          <Box marginTop={1}>
            <GroupedMultiSelect
              groups={[...new Set(auto.map((d) => d.cred.platform))].map((id) => ({
                title: rt.registry[id].name,
                items: auto
                  .filter((d) => d.cred.platform === id)
                  .map((d) => ({ id: d.cred.id, label: d.cred.label, hint: `${plural(d.cred.targets.length, 'place')} · ${d.repos.join(', ')}` })),
              }))}
              initial={auto.map((d) => d.cred.id)}
              onSubmit={(ids) => startRotating(auto.filter((d) => ids.includes(d.cred.id)))}
            />
          </Box>
        </Box>
      )}

      {phase === 'hosts' && (
        <HostsStep
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
        <LinkStep
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
        <PlatformStep
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
          onDone={(results) => {
            setOutcomes((o) => ({ ...o, ...results }));
            if (queueIndex + 1 < queue.length) setQueueIndex(queueIndex + 1);
            else setPhase(touched.current.size ? 'redeploy' : 'summary');
          }}
        />
      )}

      {phase === 'redeploy' && (
        <RedeployStep
          rt={rt}
          projects={[...touched.current.values()]}
          onDone={(lines) => {
            setRedeploys(lines);
            setPhase('summary');
          }}
        />
      )}

      {phase === 'summary' && scan && (
        <Summary
          rt={rt}
          scan={scan}
          chosen={chosen}
          manual={manual}
          outcomes={outcomes}
          redeploys={redeploys}
          onExit={() => quit(Object.values(outcomes).some((o) => o.outcome === 'failed' || o.outcome === 'partial') ? 1 : 0)}
        />
      )}
    </Box>
  );
}

// ─── 1. Folder ─────────────────────────────────────────────────────────────

function FolderStep({ onSubmit }: { onSubmit: (dir: string) => void }) {
  const [options, setOptions] = useState<{ dir: string; repos: number }[] | null>(null);
  const [typing, setTyping] = useState(false);
  const [value, setValue] = useState('~/');
  useEffect(() => {
    suggestFolders([process.cwd()]).then((s) => {
      setOptions(s);
      if (!s.length) setTyping(true);
    });
  }, []);

  return (
    <Box flexDirection="column">
      <Text bold>Where do you keep your repos?</Text>
      <Text color={color.dim}>
        Molly will look through this folder for git repos and the API keys they use. Nothing leaves your machine until you say so.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {!options ? (
          <Working label="Looking for folders with git repos…" />
        ) : typing ? (
          <Box flexDirection="column">
            <Box>
              <Text color={color.brand}>❯ </Text>
              <TextInput value={value} onChange={setValue} onSubmit={(v) => v.trim() && onSubmit(expand(v))} />
            </Box>
            <Hints hints={[['enter', 'scan this folder']]} />
          </Box>
        ) : (
          <Box flexDirection="column">
            <Select
              options={[
                ...options.slice(0, 6).map((o) => ({ label: tildify(o.dir), value: o.dir, hint: plural(o.repos, 'repo') + (o.repos >= 2 ? '+' : '') })),
                { label: 'Another folder…', value: '__other' },
              ]}
              onSubmit={(v) => (v === '__other' ? setTyping(true) : onSubmit(v))}
            />
            <Hints hints={[['↑↓', 'move'], ['enter', 'choose']]} />
          </Box>
        )}
      </Box>
    </Box>
  );
}

function ScanStep({ rt, roots, onDone }: { rt: Runtime; roots: string[]; onDone: (d: Discovery) => void }) {
  const [msg, setMsg] = useState(`Scanning ${roots.map(tildify).join(', ')}…`);
  useEffect(() => {
    scanLocal(rt, roots, setMsg).then(onDone);
  }, []);
  return <Working label={msg} />;
}

// ─── 2. What each repo uses ────────────────────────────────────────────────

function Overview({
  rt,
  scan,
  auto,
  manual,
  roots,
  onAll,
  onChoose,
  onQuit,
}: {
  rt: Runtime;
  scan: Discovery;
  auto: Draft[];
  manual: Draft[];
  roots: string[];
  onAll: () => void;
  onChoose: () => void;
  onQuit: () => void;
}) {
  const rows = scan.repos
    .map((repo) => {
      const uses = (list: Draft[]) => [...new Set(list.filter((d) => d.hits.some((h) => h.repo === repo)).map((d) => serviceName(rt, d)))];
      const where = [repo.github && 'GitHub', repo.vercel.length && 'Vercel'].filter(Boolean) as string[];
      return { repo, rotatable: uses(auto), manualOnly: uses(manual), where };
    })
    .filter((r) => r.rotatable.length || r.manualOnly.length)
    .sort((a, b) => b.rotatable.length - a.rotatable.length);
  const empty = scan.repos.length - rows.length;
  const nameW = Math.min(28, Math.max(8, ...rows.map((r) => r.repo.name.length)) + 2);

  useInput((input, key) => {
    if (!auto.length) {
      if (key.return || input === 'q') onQuit();
      return;
    }
    if (key.return) onAll();
    else if (input === 'c') onChoose();
    else if (input === 'q' || key.escape) onQuit();
  });

  if (!rows.length) {
    return (
      <Box flexDirection="column">
        <Text color={color.warn}>No API keys found in {tildify(roots[0])}.</Text>
        <Text color={color.dim}>Molly looks in .env, .env.local, .env.production and .dev.vars files (not .env.example).</Text>
        <Hints hints={[['enter', 'exit']]} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>
        {plural(rows.length, 'repo')} use {plural(new Set([...auto, ...manual].map((d) => serviceName(rt, d))).size, 'service')}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map(({ repo, rotatable, manualOnly, where }) => (
          <Text key={repo.root}>
            <Text bold>{repo.name.slice(0, nameW - 2).padEnd(nameW)}</Text>
            <Text color={color.ok}>{rotatable.join(' · ')}</Text>
            {manualOnly.length ? <Text color={color.dim}>{rotatable.length ? ' · ' : ''}{manualOnly.join(' · ')}*</Text> : null}
            {where.length ? <Text color={color.accent}>  → {where.join(', ')}</Text> : null}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {empty ? <Text color={color.dim}>{plural(empty, 'other repo')} had no keys.</Text> : null}
        {manual.length ? (
          <Text color={color.dim}>
            * {[...new Set(manual.map((d) => rt.registry[d.cred.platform].name))].join(', ')} can't be rotated by API. Molly lists where they're used at the end.
          </Text>
        ) : null}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {auto.length ? (
          <>
            <Text>
              Rotate <Text bold>{plural(auto.length, 'key')}</Text> across{' '}
              <Text bold>{plural(new Set(auto.flatMap((d) => d.hits.map((h) => h.repo.root))).size, 'repo')}</Text>?
            </Text>
            <Text color={color.dim}>Molly connects to each platform, rotates its keys, updates every repo, and checks in with you after each one.</Text>
            <Hints hints={[['enter', 'start'], ['c', 'choose which'], ['q', 'quit']]} />
          </>
        ) : (
          <Hints hints={[['enter', 'exit']]} />
        )}
      </Box>
    </Box>
  );
}

// ─── Logging in ────────────────────────────────────────────────────────────

/**
 * Makes sure Molly can talk to a platform. Reuses existing logins, runs the platform's own browser
 * login when its CLI is installed, and only falls back to asking for an admin key.
 */
function AuthGate({
  rt,
  provider,
  why,
  openUrl,
  onDone,
}: {
  rt: Runtime;
  provider: Provider;
  why: string;
  openUrl: (u: string) => void;
  onDone: (ok: boolean, label?: string) => void;
}) {
  const { suspendTerminal } = useApp();
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
      setError((e) => e || `Log in to ${provider.name} first, then press enter.`);
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

  useEffect(() => {
    void check();
  }, []);

  useInput(
    (input, key) => {
      if (mode === 'login') {
        if (key.return) {
          if (cli) void suspendTerminal(() => provider.cliLogin!.run()).then(check);
          else void check();
        } else if (input === 'k' && cli && required.length) startPaste();
        else if (input === 's' || key.escape) onDone(false);
      } else if (mode === 'paste' && key.escape) onDone(false);
    },
    { isActive: mode !== 'checking' },
  );
  usePaste((text) => setValue((v) => v + text.trim()), { isActive: mode === 'paste' });

  if (mode === 'checking') return <Working label={`Connecting to ${provider.name}…`} />;

  const field = required[fieldIdx];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.brand} paddingX={1}>
      <Text>
        <Text bold color={color.brand}>
          Log in to {provider.name}
        </Text>
        <Text color={color.dim}>  {why}</Text>
      </Text>
      {error ? <Text color={color.warn}>{error}</Text> : null}
      {mode === 'login' ? (
        <Box flexDirection="column" marginTop={1}>
          {cli ? <Text>Press enter and Molly will open the {provider.cliLogin!.label} login in your browser.</Text> : null}
          <Hints
            hints={[
              ['enter', cli ? 'log in' : 'check again'],
              ...(cli && required.length ? ([['k', 'use an API key instead']] as [string, string][]) : []),
              ['s', `skip ${provider.name}`],
            ]}
          />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {provider.name} has no browser login for tools, so it needs a <Text bold>{field.label}</Text> once.
          </Text>
          {provider.loginUrl ? (
            <Text color={color.dim}>
              {rt.demo ? 'Create one at ' : 'Opened '}
              {provider.loginUrl}
              {field.help ? ` · ${field.help}` : ''}
            </Text>
          ) : field.help ? (
            <Text color={color.dim}>{field.help}</Text>
          ) : null}
          <Text color={color.dim}>Saved in your macOS keychain, so you only do this once.</Text>
          <Box marginTop={1}>
            <Text color={color.brand}>❯ </Text>
            <TextInput
              value={value}
              mask={field.secret ? '•' : undefined}
              placeholder={field.secret ? 'paste it here' : ''}
              onChange={setValue}
              onSubmit={(v) => {
                if (!v.trim()) return;
                entered.current[field.key] = v.trim();
                setValue('');
                setError('');
                if (fieldIdx + 1 < required.length) setFieldIdx(fieldIdx + 1);
                else void check();
              }}
            />
          </Box>
          <Hints hints={[['enter', 'connect'], ['esc', `skip ${provider.name}`]]} />
        </Box>
      )}
    </Box>
  );
}

function HostsStep({ rt, needed, openUrl, onDone }: { rt: Runtime; needed: string[]; openUrl: (u: string) => void; onDone: (connected: string[]) => void }) {
  const [i, setI] = useState(0);
  const connected = useRef<string[]>([]);
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    if (i >= needed.length) onDone(connected.current);
  }, [i]);
  const host = rt.registry[needed[i]];
  return (
    <Box flexDirection="column">
      {lines.map((l) => (
        <Text key={l}>{l}</Text>
      ))}
      {host && (
        <AuthGate
          key={host.id}
          rt={rt}
          provider={host}
          openUrl={openUrl}
          why={host.id === 'github' ? 'so Molly can update your repos’ Actions secrets' : 'so Molly can update your projects’ env vars'}
          onDone={(ok, label) => {
            if (ok) connected.current.push(host.id);
            setLines((l) => [...l, ok ? `✓ ${host.name}${label ? `  ${label}` : ''}` : `– ${host.name} skipped: Molly will only update local files`]);
            setI(i + 1);
          }}
        />
      )}
    </Box>
  );
}

function LinkStep({ rt, scan, hosts, onDone }: { rt: Runtime; scan: Discovery; hosts: string[]; onDone: () => void }) {
  const [msg, setMsg] = useState('Finding where each key is used…');
  useEffect(() => {
    linkRemotes(rt, scan, hosts, setMsg).then(onDone);
  }, []);
  return <Working label={msg} />;
}

// ─── 3. One platform at a time ─────────────────────────────────────────────

interface CredView {
  status: 'pending' | 'active' | Outcome;
  step?: Step;
  targets: Record<number, { status: 'ok' | 'error' | 'skipped'; message?: string }>;
  message?: string;
  followUps: string[];
}

const STEP_LABEL: Record<Step, string> = {
  resolve: 'Finding the current key',
  issue: 'Creating a new key',
  prompt: 'Waiting',
  verify: 'Checking the new key works',
  propagate: 'Updating your repos',
  revoke: 'Revoking the old key',
  redeploy: 'Redeploying',
};

function PlatformStep({
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
  onDone: (results: Record<string, { outcome: Outcome; note?: string; followUps: string[] }>) => void;
}) {
  const [mode, setMode] = useState<'auth' | 'prepare' | 'question' | 'rotate' | 'result'>(provider.auth?.length ? 'auth' : 'prepare');
  const [account, setAccount] = useState<string>();
  const [questions, setQuestions] = useState<{ cred: CredentialSpec; q: Question }[]>([]);
  const [qIndex, setQIndex] = useState(0);
  const [views, setViews] = useState<Record<string, CredView>>(() =>
    Object.fromEntries(drafts.map((d) => [d.cred.id, { status: 'pending', targets: {}, followUps: [] }])),
  );
  const prepFailures = useRef<Record<string, string>>({});

  const results = () =>
    Object.fromEntries(
      drafts.map((d) => {
        const v = views[d.cred.id];
        const outcome: Outcome = v.status === 'pending' || v.status === 'active' ? 'skipped' : v.status;
        return [d.cred.id, { outcome, note: v.message, followUps: v.followUps }];
      }),
    );

  const skipAll = (why: string) => {
    const out = Object.fromEntries(drafts.map((d) => [d.cred.id, { outcome: 'skipped' as Outcome, note: why, followUps: [] }]));
    onDone(out);
  };

  // Fill in per-key details (which project, which IAM user…) now that Molly can talk to the platform.
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
      for (const d of drafts) {
        if (prepFailures.current[d.cred.id]) {
          setViews((v) => ({ ...v, [d.cred.id]: { ...v[d.cred.id], status: 'failed', message: prepFailures.current[d.cred.id] } }));
          continue;
        }
        await rollCredential(
          rt,
          config,
          d.cred,
          { emit: (e) => setViews((v) => applyEvent(v, e)), prompt: async () => null },
          opts,
          touched,
          save,
        );
      }
      setMode('result');
    })();
  }, [mode]);

  useInput(
    (input, key) => {
      if (mode === 'result' && (key.return || input === ' ')) onDone(results());
    },
    { isActive: mode === 'result' },
  );

  const places = drafts.reduce((n, d) => n + d.cred.targets.length, 0);
  const repos = [...new Set(drafts.flatMap((d) => d.repos))];
  const allOk = drafts.every((d) => views[d.cred.id].status === 'rolled');

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color.dim}>
          {index + 1}/{total}{'  '}
        </Text>
        <Text bold color={color.brand}>
          {provider.name}
        </Text>
        <Text color={color.dim}>
          {'  '}
          {plural(drafts.length, 'key')} · {plural(places, 'place')} · {repos.join(', ')}
          {account ? ` · ${account}` : ''}
        </Text>
      </Text>
      {provider.warning && mode !== 'result' ? <Text color={color.dim}>{provider.warning}</Text> : null}

      <Box flexDirection="column" marginTop={1}>
        {mode === 'auth' && (
          <AuthGate
            rt={rt}
            provider={provider}
            openUrl={openUrl}
            why="so Molly can create the new key and revoke the old one"
            onDone={(ok, label) => {
              if (!ok) return skipAll('skipped (not logged in)');
              setAccount(label);
              setMode('prepare');
            }}
          />
        )}
        {mode === 'prepare' && <Working label={`Looking up your ${provider.name} account…`} />}
        {mode === 'question' && questions[qIndex] && (
          <Box flexDirection="column">
            <Text bold>{questions[qIndex].q.prompt}</Text>
            <Select
              key={qIndex}
              options={questions[qIndex].q.options}
              onSubmit={(v) => {
                questions[qIndex].cred.params[questions[qIndex].q.param] = v;
                if (qIndex + 1 < questions.length) setQIndex(qIndex + 1);
                else void save().then(() => setMode('rotate'));
              }}
            />
          </Box>
        )}
        {(mode === 'rotate' || mode === 'result') &&
          drafts.map((d) => <CredRow key={d.cred.id} cred={d.cred} view={views[d.cred.id]} />)}
      </Box>

      {mode === 'result' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={allOk ? color.ok : color.warn}>
            {allOk ? `✓ ${provider.name} rotated` : `◐ ${provider.name} needs attention`}
          </Text>
          {drafts.flatMap((d) => views[d.cred.id].followUps).map((f, i) => (
            <Text key={i} color={color.dim}>
              • {f}
            </Text>
          ))}
          <Hints hints={[['enter', next ? `next: ${next}` : 'finish']]} />
        </Box>
      )}
    </Box>
  );
}

function applyEvent(v: Record<string, CredView>, e: RollEvent): Record<string, CredView> {
  if (e.type === 'redeploy') return v;
  const cur = v[e.id];
  switch (e.type) {
    case 'cred-start':
      return { ...v, [e.id]: { ...cur, status: 'active' } };
    case 'step':
      return { ...v, [e.id]: { ...cur, step: e.step } };
    case 'target':
      return { ...v, [e.id]: { ...cur, targets: { ...cur.targets, [e.index]: { status: e.status, message: e.message } } } };
    case 'cred-done':
      return { ...v, [e.id]: { ...cur, status: e.status, message: e.message, followUps: e.followUps } };
  }
}

function CredRow({ cred, view }: { cred: CredentialSpec; view: CredView }) {
  const icon = { pending: '○', rolled: '✓', partial: '◐', failed: '✗', skipped: '–' } as const;
  const tint = { pending: color.dim, active: color.brand, rolled: color.ok, partial: color.warn, failed: color.err, skipped: color.dim };
  const showTargets = view.status === 'active' ? view.step === 'propagate' || view.step === 'revoke' : view.status !== 'pending';
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={tint[view.status]}>{view.status === 'active' ? <Spinner type="dots" /> : icon[view.status]}</Text>{' '}
        <Text bold>{cred.label}</Text>
        {view.status === 'active' && view.step ? <Text color={color.dim}>  {STEP_LABEL[view.step]}…</Text> : null}
        {view.status === 'failed' ? <Text color={color.err}>  {view.message}</Text> : null}
      </Text>
      {showTargets &&
        cred.targets.map((t, i) => {
          const s = view.targets[i];
          return (
            <Text key={i} color={s?.status === 'error' ? color.err : color.dim}>
              {'    '}
              {s ? s.status === 'ok' ? <Text color={color.ok}>✓</Text> : '✗' : '·'} {tildify(describeTarget(t))}  {t.key}
              {s?.message ? `: ${s.message}` : ''}
            </Text>
          );
        })}
      {view.status === 'partial' && view.message ? <Text color={color.warn}>    {view.message}</Text> : null}
    </Box>
  );
}

// ─── 4. Wrap up ────────────────────────────────────────────────────────────

function RedeployStep({
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
  if (running) return <Working label="Redeploying…" />;
  return (
    <Text>
      Redeploy {projects.map((p) => p.name).join(', ')} on Vercel so production picks up the new keys? <Confirm onAnswer={run} />
    </Text>
  );
}

function Summary({
  rt,
  scan,
  chosen,
  manual,
  outcomes,
  redeploys,
  onExit,
}: {
  rt: Runtime;
  scan: Discovery;
  chosen: Draft[];
  manual: Draft[];
  outcomes: Record<string, { outcome: Outcome; note?: string; followUps: string[] }>;
  redeploys: string[];
  onExit: () => void;
}) {
  useInput((input, key) => (key.return || input === 'q' || key.escape) && onExit());
  const rolled = Object.values(outcomes).filter((o) => o.outcome === 'rolled').length;
  const mark = { rolled: ['✓', color.ok], partial: ['◐', color.warn], failed: ['✗', color.err], skipped: ['–', color.dim] } as const;
  const repos = scan.repos.filter((r) => [...chosen, ...manual].some((d) => d.hits.some((h) => h.repo === r)));
  const nameW = Math.min(28, Math.max(8, ...repos.map((r) => r.name.length)) + 2);
  const followUps = chosen.flatMap((d) => (outcomes[d.cred.id]?.followUps ?? []).map((f) => `${serviceName(rt, d)}: ${f}`));
  const problems = chosen.filter((d) => ['failed', 'partial'].includes(outcomes[d.cred.id]?.outcome));

  return (
    <Box flexDirection="column">
      <Text bold color={problems.length ? color.warn : color.ok}>
        {problems.length ? '◐' : '✓'} Rotated {rolled} of {plural(chosen.length, 'key')}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {repos.map((repo) => {
          const mine = chosen.filter((d) => d.hits.some((h) => h.repo === repo));
          const theirs = [...new Set(manual.filter((d) => d.hits.some((h) => h.repo === repo)).map((d) => serviceName(rt, d)))];
          return (
            <Text key={repo.root}>
              <Text bold>{repo.name.slice(0, nameW - 2).padEnd(nameW)}</Text>
              {mine.map((d, i) => {
                const [icon, c] = mark[outcomes[d.cred.id]?.outcome ?? 'skipped'];
                return (
                  <Text key={d.cred.id}>
                    {i ? '  ' : ''}
                    <Text color={c}>{icon}</Text> {serviceName(rt, d)}
                  </Text>
                );
              })}
              {theirs.length ? <Text color={color.dim}>{mine.length ? '  ' : ''}○ {theirs.join(', ')} (manual)</Text> : null}
            </Text>
          );
        })}
      </Box>
      {redeploys.length ? (
        <Box flexDirection="column" marginTop={1}>
          {redeploys.map((l) => (
            <Text key={l}>{l}</Text>
          ))}
        </Box>
      ) : null}
      {problems.length ? (
        <Box flexDirection="column" marginTop={1}>
          {problems.map((d) => (
            <Text key={d.cred.id} color={color.warn}>
              • {serviceName(rt, d)} {d.cred.label}: {outcomes[d.cred.id].note}
            </Text>
          ))}
        </Box>
      ) : null}
      {followUps.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Left for you</Text>
          {followUps.map((f, i) => (
            <Text key={i} color={color.dim}>
              • {f}
            </Text>
          ))}
        </Box>
      ) : null}
      {manual.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>No rotation API</Text>
          <Text color={color.dim}>These platforms only let you create keys in their dashboard:</Text>
          {[...new Set(manual.map((d) => d.cred.platform))].map((id) => (
            <Text key={id} color={color.dim}>
              • {rt.registry[id].name}: {rt.registry[id].dashboardUrl} ({manual.filter((d) => d.cred.platform === id).map((d) => d.cred.label).join(', ')})
            </Text>
          ))}
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={color.dim}>
          Next time just run <Text color={color.accent}>molly</Text>. Your logins are saved, so it goes straight to rotating.
        </Text>
      </Box>
      <Hints hints={[['enter', 'done']]} />
    </Box>
  );
}
