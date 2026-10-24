import { Box, Text } from 'ink';
import React from 'react';
import { tildify, type MollyConfig } from '../core/config.js';
import type { Runtime } from '../core/runtime.js';
import { plural, repoCount, since } from '../core/util.js';
import { describeTarget } from '../targets/types.js';
import { color, Header, ModeBadge } from './components.js';

export function Status({ rt, config, verbose }: { rt: Runtime; config: MollyConfig; verbose?: boolean }) {
  const nameW = Math.max(8, ...config.credentials.map((c) => rt.registry[c.platform]?.name.length ?? 0)) + 2;
  const labelW = Math.min(40, Math.max(10, ...config.credentials.map((c) => c.label.length)) + 2);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Header subtitle={`${plural(config.credentials.length, 'secret')} · ${plural(repoCount(config.credentials), 'repo')}`} />
      {config.credentials.map((c) => {
        const p = rt.registry[c.platform];
        const age = c.state.rotatedAt ? (Date.now() - Date.parse(c.state.rotatedAt)) / 86_400_000 : Infinity;
        return (
          <Box key={c.id} flexDirection="column">
            <Text>
              <Text color={age > 90 ? color.warn : age > 30 ? undefined : color.ok}>●</Text> {(p?.name ?? c.platform).padEnd(nameW)}
              <Text bold>{c.label.slice(0, labelW - 2).padEnd(labelW)}</Text>
              {p ? <ModeBadge mode={p.mode} /> : null}
              <Text color={color.dim}>
                {'  '}
                {plural(c.targets.length, 'place').padStart(9)} · rolled {since(c.state.rotatedAt)}
                {c.state.pendingRevoke?.length ? ' · old key pending `molly finalize`' : ''}
              </Text>
              <Text color={color.dim}>  {c.id}</Text>
            </Text>
            {verbose
              ? c.targets.map((t, i) => (
                  <Text key={i} color={color.dim}>
                    {'    '}↳ {tildify(describeTarget(t))} {t.type === 'dotenv' ? '' : t.key}
                  </Text>
                ))
              : null}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={color.dim}>
          <Text color={color.accent}>molly roll</Text> rotate everything · <Text color={color.accent}>molly roll --only {'<id|platform>'}</Text> ·{' '}
          <Text color={color.accent}>molly status -v</Text> show every place
        </Text>
      </Box>
    </Box>
  );
}
