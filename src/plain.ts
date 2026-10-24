import { saveConfig, tildify, type MollyConfig } from './core/config.js';
import { preflight, rollAll, type RollOptions } from './core/engine.js';
import type { Runtime } from './core/runtime.js';
import { describeTarget } from './targets/types.js';

/** Line-oriented `molly roll` for CI and non-interactive shells. Guided platforms are skipped. */
export async function plainRoll(rt: Runtime, config: MollyConfig, opts: RollOptions): Promise<number> {
  const plan = await preflight(rt, config, opts);
  for (const p of plan) {
    console.log(`• ${p.provider.name} ${p.cred.label} (${p.cred.targets.length} places)${p.resuming ? ' [resume]' : ''}`);
    for (const pr of p.problems) console.log(`  ! ${tildify(describeTarget(p.cred.targets[pr.index]))}: ${pr.message}`);
  }
  if (opts.dryRun || !plan.length) return 0;

  const byId = new Map(plan.map((p) => [p.cred.id, p]));
  let bad = 0;
  await rollAll(
    rt,
    config,
    {
      emit(e) {
        if (e.type === 'step') console.log(`  ${e.id}: ${e.step}`);
        if (e.type === 'target' && e.status !== 'ok') {
          const t = byId.get(e.id)!.cred.targets[e.index];
          console.log(`  ✗ ${tildify(describeTarget(t))} ${t.key}: ${e.message}`);
        }
        if (e.type === 'cred-done') {
          if (e.status === 'failed' || e.status === 'partial') bad++;
          console.log(`${e.status === 'rolled' ? '✓' : e.status === 'skipped' ? '-' : '✗'} ${e.id}: ${e.status}${e.message ? ` (${e.message})` : ''}`);
          for (const f of e.followUps) console.log(`  → ${f}`);
        }
        if (e.type === 'redeploy') console.log(`${e.status === 'ok' ? '✓' : '↻'} Vercel ${e.project}: ${e.message}`);
      },
      async prompt() {
        return null;
      },
    },
    opts,
    () => saveConfig(config),
  );
  return bad ? 1 : 0;
}
