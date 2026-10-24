#!/usr/bin/env node
import { Command } from 'commander';
import { render, renderToString } from 'ink';
import React from 'react';
import { loadConfig, saveConfig, tildify, type MollyConfig } from './core/config.js';
import { finalize, type RollOptions } from './core/engine.js';
import { liveRuntime, type Runtime } from './core/runtime.js';
import { authKey } from './core/store.js';
import { createDemoWorkspace, demoRuntime } from './demo.js';
import { plainRoll } from './plain.js';
import { MouseInput, MouseProvider } from './ui/mouse.js';
import { Session } from './ui/Session.js';
import { Status } from './ui/Status.js';

const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

async function openUrl(url: string) {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch {}
}

async function runSession(rt: Runtime, opts: RollOptions & { plain?: boolean }, extra: { askFolder?: boolean; roots?: string[] } = {}) {
  const existing = await loadConfig();
  if (opts.plain || !interactive()) {
    if (!existing?.credentials.length) {
      console.error('Nothing to roll yet. Run `molly` in an interactive terminal first.');
      process.exitCode = 1;
      return;
    }
    process.exitCode = await plainRoll(rt, existing, opts);
    return;
  }
  let code = 0;
  const mouse = new MouseInput();
  process.once('exit', () => mouse.stop());
  const app = render(
    <MouseProvider input={mouse}>
      <Session rt={rt} existing={existing} opts={opts} openUrl={openUrl} onExit={(c) => (code = c)} {...extra} />
    </MouseProvider>,
    { stdin: mouse.stdin, alternateScreen: true, incrementalRendering: true },
  );
  mouse.start();
  await app.waitUntilExit();
  mouse.stop();
  process.exitCode = code;
}

async function requireConfig(): Promise<MollyConfig | null> {
  const cfg = await loadConfig();
  if (!cfg) console.log('No Molly config yet. Run `molly setup` to get started.');
  return cfg;
}

const program = new Command()
  .name('molly')
  .description('Rotate the API keys and secrets for all your projects at once. Run `molly` and follow along.')
  .version('0.1.0');

const rollOptions = (cmd: Command) =>
  cmd
    .option('--keep-old', "don't revoke old keys yet (run `molly finalize` later)")
    .option('--force', 'overwrite values that were changed outside Molly')
    .option('--plain', 'non-interactive output for CI; uses the saved setup')
    .option('-o, --only <ids...>', 'with --plain: only these credential ids or platforms')
    .option('-n, --dry-run', 'with --plain: show the plan without changing anything');

rollOptions(program.command('roll').description('rotate your keys (same as running `molly`)')).action(async (o) => {
  await runSession(liveRuntime(), o);
});

program
  .command('setup')
  .description('choose a different work folder, then rotate')
  .action(async () => {
    await runSession(liveRuntime(), {}, { askFolder: true });
  });

program
  .command('status')
  .alias('ls')
  .description('list managed secrets, where they live, and when they were last rolled')
  .option('-v, --verbose', 'show every place each secret is used')
  .action(async (o) => {
    const cfg = await requireConfig();
    if (cfg) console.log(renderToString(<Status rt={liveRuntime()} config={cfg} verbose={o.verbose} />, { columns: process.stdout.columns || 120 }));
  });

program
  .command('finalize')
  .description('revoke old keys kept alive by `molly roll --keep-old`')
  .action(async () => {
    const cfg = await requireConfig();
    if (!cfg) return;
    if (!cfg.credentials.some((c) => c.state.pendingRevoke?.length)) return console.log('Nothing pending.');
    await finalize(liveRuntime(), cfg, console.log);
    await saveConfig(cfg);
  });

program
  .command('disconnect <platform>')
  .description("forget a platform's stored credentials (keychain)")
  .action(async (platform: string) => {
    const rt = liveRuntime();
    const p = rt.registry[platform];
    if (!p) return console.error(`Unknown platform "${platform}". Known: ${Object.keys(rt.registry).join(', ')}`);
    for (const f of p.auth ?? []) await rt.store.delete(authKey(p.id, f.key)).catch(() => {});
    console.log(`Removed stored ${p.name} credentials from your keychain.`);
  });

program
  .command('demo')
  .description('try Molly end to end on throwaway repos with fake keys')
  .action(async () => {
    const { root, home } = await createDemoWorkspace();
    process.env.MOLLY_HOME = home;
    await runSession(demoRuntime(), {}, { roots: [root] });
    console.log(`\nDemo repos are in ${tildify(root)}. Open their .env files to see what changed.`);
  });

rollOptions(program).action(async (o) => {
  await runSession(liveRuntime(), o);
});

program.parseAsync().catch((err) => {
  console.error(`molly: ${err.message}`);
  process.exit(1);
});
