import { Box, Text } from 'ink';
import React from 'react';
import type { Mode } from '../providers/types.js';

export const color = {
  brand: '#FF6AC1',
  accent: '#8AB4F8',
  ok: '#7BD88F',
  warn: '#F5C451',
  err: '#FF6B6B',
  dim: 'gray',
};

export function Header({ subtitle, step, total }: { subtitle?: string; step?: number; total?: number }) {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text>
        <Text color={color.brand} bold>
          ◆ molly
        </Text>
        {subtitle ? <Text color={color.dim}>  {subtitle}</Text> : null}
        {step ? (
          <Text color={color.dim}>
            {'  '}· step {step} of {total}
          </Text>
        ) : null}
      </Text>
    </Box>
  );
}

export function ModeBadge({ mode }: { mode: Mode }) {
  if (mode === 'auto') return <Text color={color.ok}>auto  </Text>;
  if (mode === 'guided') return <Text color={color.warn}>guided</Text>;
  return <Text color={color.accent}>sync  </Text>;
}
