import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import React, { useState } from 'react';
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

export function Hints({ hints }: { hints: [string, string][] }) {
  return (
    <Box marginTop={1}>
      <Text color={color.dim}>
        {hints.map(([k, label], i) => (
          <Text key={k}>
            {i ? '   ' : ''}
            <Text color={color.accent}>{k}</Text> {label}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

export function ModeBadge({ mode }: { mode: Mode }) {
  if (mode === 'auto') return <Text color={color.ok}>auto  </Text>;
  if (mode === 'guided') return <Text color={color.warn}>guided</Text>;
  return <Text color={color.accent}>sync  </Text>;
}

export function Working({ label }: { label: string }) {
  return (
    <Text>
      <Text color={color.brand}>
        <Spinner type="dots" />
      </Text>{' '}
      {label}
    </Text>
  );
}

export interface PickItem {
  id: string;
  label: string;
  hint?: string;
  right?: React.ReactNode;
  detail?: string[];
}

export interface PickGroup {
  title: string;
  hint?: string;
  items: PickItem[];
}

/** Checkbox list with group headings. Space toggles, `a` toggles a whole group. */
export function GroupedMultiSelect({
  groups,
  initial,
  onSubmit,
  minSelected = 1,
  maxVisible = 18,
}: {
  groups: PickGroup[];
  initial: string[];
  onSubmit: (ids: string[]) => void;
  minSelected?: number;
  maxVisible?: number;
}) {
  const flat = groups.flatMap((g, gi) => g.items.map((item) => ({ item, gi })));
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(() => new Set(initial));
  const [error, setError] = useState('');

  useInput((input, key) => {
    if (key.upArrow || input === 'k') setCursor((c) => (c - 1 + flat.length) % flat.length);
    else if (key.downArrow || input === 'j') setCursor((c) => (c + 1) % flat.length);
    else if (input === ' ') {
      const id = flat[cursor].item.id;
      setSelected((s) => {
        const n = new Set(s);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      });
      setError('');
    } else if (input === 'a') {
      const ids = groups[flat[cursor].gi].items.map((i) => i.id);
      setSelected((s) => {
        const n = new Set(s);
        const all = ids.every((id) => n.has(id));
        ids.forEach((id) => (all ? n.delete(id) : n.add(id)));
        return n;
      });
    } else if (key.return) {
      if (selected.size < minSelected) setError('Select at least one (space to toggle).');
      else onSubmit(flat.filter(({ item }) => selected.has(item.id)).map(({ item }) => item.id));
    }
  });

  // Keep the cursor's group in view on short terminals.
  const rows: React.ReactNode[] = [];
  let index = 0;
  groups.forEach((g, gi) => {
    rows.push(
      <Box key={`g${gi}`} marginTop={gi ? 1 : 0}>
        <Text bold color={color.accent}>
          {g.title}
        </Text>
        {g.hint ? <Text color={color.dim}>  {g.hint}</Text> : null}
      </Box>,
    );
    for (const item of g.items) {
      const i = index++;
      const active = i === cursor;
      const on = selected.has(item.id);
      rows.push(
        <Box key={item.id} flexDirection="column">
          <Text>
            <Text color={active ? color.brand : undefined}>{active ? '❯ ' : '  '}</Text>
            <Text color={on ? color.ok : color.dim}>{on ? '◉' : '○'}</Text> <Text bold={active}>{item.label}</Text>
            {item.right ? <Text>  {item.right}</Text> : null}
            {item.hint ? <Text color={color.dim}>  {item.hint}</Text> : null}
          </Text>
          {active && item.detail?.length
            ? item.detail.map((d, di) => (
                <Text key={di} color={color.dim}>
                  {'      '}
                  {d}
                </Text>
              ))
            : null}
        </Box>,
      );
    }
  });

  const activeRow = rows.findIndex((r: any) => r.key === flat[cursor].item.id);
  const start = Math.max(0, Math.min(activeRow - Math.floor(maxVisible / 2), rows.length - maxVisible));
  const visible = rows.length > maxVisible ? rows.slice(start, start + maxVisible) : rows;

  return (
    <Box flexDirection="column">
      {start > 0 && rows.length > maxVisible ? <Text color={color.dim}>  ↑ more</Text> : null}
      {visible}
      {rows.length > maxVisible && start + maxVisible < rows.length ? <Text color={color.dim}>  ↓ more</Text> : null}
      {error ? <Text color={color.err}>{error}</Text> : null}
      <Hints
        hints={[
          ['↑↓', 'move'],
          ['space', 'toggle'],
          ['a', 'toggle group'],
          ['enter', `continue (${selected.size} selected)`],
        ]}
      />
    </Box>
  );
}

export function Select<T extends string>({
  options,
  onSubmit,
}: {
  options: { label: string; value: T; hint?: string }[];
  onSubmit: (value: T) => void;
}) {
  const [cursor, setCursor] = useState(0);
  useInput((input, key) => {
    if (key.upArrow || input === 'k') setCursor((c) => (c - 1 + options.length) % options.length);
    else if (key.downArrow || input === 'j') setCursor((c) => (c + 1) % options.length);
    else if (key.return) onSubmit(options[cursor].value);
  });
  return (
    <Box flexDirection="column">
      {options.map((o, i) => (
        <Text key={o.value}>
          <Text color={i === cursor ? color.brand : undefined}>{i === cursor ? '❯ ' : '  '}</Text>
          <Text bold={i === cursor}>{o.label}</Text>
          {o.hint ? <Text color={color.dim}>  {o.hint}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

export function Confirm({ onAnswer, defaultYes = true }: { onAnswer: (yes: boolean) => void; defaultYes?: boolean }) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onAnswer(true);
    else if (input === 'n' || input === 'N' || key.escape || input === 'q') onAnswer(false);
    else if (key.return) onAnswer(defaultYes);
  });
  return <Text color={color.dim}>{defaultYes ? '[Y/n]' : '[y/N]'}</Text>;
}
