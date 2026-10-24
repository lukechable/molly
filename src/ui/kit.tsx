import { Box, Text, useInput, useWindowSize } from 'ink';
import Spinner from 'ink-spinner';
import React, { createContext, useContext } from 'react';
import { useMouse } from './mouse.js';

export const c = {
  brand: '#FF6AC1',
  brandDim: '#7A2E5C',
  accent: '#8AB4F8',
  ok: '#7BD88F',
  okBg: '#1F3B27',
  warn: '#F5C451',
  err: '#FF6B6B',
  dim: 'gray',
  panel: '#2A2A33',
  chip: '#33333D',
};

// ─── Frame: the full-screen layout every screen renders into ──────────────

export const STEPS = ['Folder', 'Repos', 'Log in & rotate', 'Done'];

export interface SidebarItem {
  label: string;
  status: 'pending' | 'active' | 'done' | 'warn' | 'error' | 'skipped' | 'info';
}

export interface FrameState {
  step: number;
  demo?: boolean;
  sidebar: { title: string; items: SidebarItem[] }[];
}

export const FrameContext = createContext<FrameState>({ step: 0, sidebar: [] });

export interface ButtonSpec {
  label: string;
  onPress: () => void;
  /** Single key shown on the button. "enter" is implied for the primary button. */
  hotkey?: string;
  primary?: boolean;
  disabled?: boolean;
}

const ICON: Record<SidebarItem['status'], [string, string]> = {
  pending: ['○', c.dim],
  active: ['◉', c.brand],
  done: ['✓', c.ok],
  warn: ['◐', c.warn],
  error: ['✗', c.err],
  skipped: ['–', c.dim],
  info: ['•', c.dim],
};

export function Frame({
  children,
  buttons = [],
  typing = false,
  hint,
}: {
  children: React.ReactNode;
  buttons?: ButtonSpec[];
  /** A text field has focus: letter hotkeys are disabled so typing works. */
  typing?: boolean;
  hint?: string;
}) {
  const { columns, rows } = useWindowSize();
  const { step, demo, sidebar } = useContext(FrameContext);
  const showSidebar = columns >= 80 && sidebar.some((s) => s.items.length);
  const sideW = Math.min(30, Math.max(22, Math.floor(columns * 0.24)));

  useInput((input, key) => {
    for (const b of buttons) {
      if (b.disabled) continue;
      if (b.primary && key.return && !typing) return b.onPress();
      if (b.hotkey === 'esc' && key.escape) return b.onPress();
      if (!typing && b.hotkey && b.hotkey.length === 1 && input.toLowerCase() === b.hotkey) return b.onPress();
    }
  });

  return (
    <Box width={columns} height={rows} flexDirection="column" borderStyle="round" borderColor={c.brandDim}>
      <Box paddingX={1} justifyContent="space-between">
        <Text>
          <Text color={c.brand} bold>
            ◆ molly
          </Text>
          {demo ? <Text color={c.dim}>  demo · fake repos, fake keys</Text> : null}
        </Text>
        <Stepper step={step} compact={columns < 100} />
      </Box>
      <Rule />
      <Box flexGrow={1} flexDirection="row">
        {showSidebar ? (
          <Box width={sideW} flexShrink={0} flexDirection="column" paddingX={1} paddingTop={1} overflow="hidden">
            {sidebar
              .filter((s) => s.items.length)
              .map((section, i) => (
                <Box key={section.title} flexDirection="column" marginTop={i ? 1 : 0}>
                  <Text color={c.dim} bold>
                    {section.title.toUpperCase()}
                  </Text>
                  {section.items.slice(0, Math.max(3, Math.floor((rows - 10) / Math.max(1, sidebar.length)))).map((item, j) => (
                    <Text key={j} wrap="truncate-end">
                      <Text color={ICON[item.status][1]}>{ICON[item.status][0]}</Text>{' '}
                      <Text color={item.status === 'pending' || item.status === 'skipped' ? c.dim : undefined} bold={item.status === 'active'}>
                        {item.label}
                      </Text>
                    </Text>
                  ))}
                </Box>
              ))}
          </Box>
        ) : null}
        {showSidebar ? <VRule /> : null}
        <Box flexGrow={1} flexDirection="column" paddingX={2} paddingTop={1} overflow="hidden">
          {children}
        </Box>
      </Box>
      <Rule />
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          {buttons.map((b) => (
            <Button key={b.label} {...b} />
          ))}
        </Box>
        <Text color={c.dim}>{hint ?? (buttons.length ? 'click or press a key' : '')}  ctrl+c quit</Text>
      </Box>
    </Box>
  );
}

function Rule() {
  return <Box borderStyle="single" borderColor={c.brandDim} borderTop borderBottom={false} borderLeft={false} borderRight={false} />;
}

function VRule() {
  return <Box borderStyle="single" borderColor={c.brandDim} borderLeft borderTop={false} borderBottom={false} borderRight={false} />;
}

function Stepper({ step, compact }: { step: number; compact: boolean }) {
  return (
    <Text>
      {STEPS.map((s, i) => (
        <Text key={s}>
          {i ? <Text color={c.dim}>{compact ? ' ' : ' ── '}</Text> : null}
          <Text color={i < step ? c.ok : i === step ? c.brand : c.dim}>{i < step ? '●' : i === step ? '◉' : '○'}</Text>
          {!compact || i === step ? (
            <Text color={i === step ? undefined : c.dim} bold={i === step}>
              {' '}
              {s}
            </Text>
          ) : null}
        </Text>
      ))}
    </Text>
  );
}

export function Button({ label, onPress, hotkey, primary, disabled }: ButtonSpec) {
  const ref = useMouse({ onClick: disabled ? undefined : onPress });
  const key = primary ? '⏎' : hotkey === 'esc' ? 'esc' : hotkey;
  return (
    <Box ref={ref} backgroundColor={disabled ? undefined : primary ? c.brand : c.chip} paddingX={1}>
      <Text color={disabled ? c.dim : primary ? 'black' : 'white'} bold={primary}>
        {label}
        {key ? <Text color={primary ? '#4A1A38' : c.dim}> {key}</Text> : null}
      </Text>
    </Box>
  );
}

// ─── Building blocks ─────────────────────────────────────────────────────────

export function Title({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{children}</Text>
      {sub ? <Text color={c.dim}>{sub}</Text> : null}
    </Box>
  );
}

export function Card({
  title,
  right,
  tone = 'brand',
  children,
}: {
  title?: React.ReactNode;
  right?: React.ReactNode;
  tone?: 'brand' | 'ok' | 'warn' | 'plain';
  children: React.ReactNode;
}) {
  const border = { brand: c.brand, ok: c.ok, warn: c.warn, plain: c.dim }[tone];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={border} paddingX={1}>
      {title || right ? (
        <Box justifyContent="space-between" marginBottom={1}>
          <Text bold color={tone === 'plain' ? undefined : border}>
            {title}
          </Text>
          {right ? <Text color={c.dim}>{right}</Text> : null}
        </Box>
      ) : null}
      {children}
    </Box>
  );
}

export function Chip({ label, tone = 'ok' }: { label: string; tone?: 'ok' | 'dim' | 'warn' | 'err' }) {
  const fg = { ok: c.ok, dim: c.dim, warn: c.warn, err: c.err }[tone];
  return (
    <Box backgroundColor={c.chip} paddingX={1} marginRight={1}>
      <Text color={fg}>{label}</Text>
    </Box>
  );
}

export function Bar({ value, total, width = 30 }: { value: number; total: number; width?: number }) {
  const filled = total ? Math.round((value / total) * width) : 0;
  return (
    <Text>
      <Text color={c.brand}>{'█'.repeat(filled)}</Text>
      <Text color={c.panel}>{'█'.repeat(width - filled)}</Text>
      <Text color={c.dim}>
        {'  '}
        {value}/{total}
      </Text>
    </Text>
  );
}

export function Busy({ label }: { label: string }) {
  return (
    <Text>
      <Text color={c.brand}>
        <Spinner type="dots" />
      </Text>{' '}
      {label}
    </Text>
  );
}

/** A selectable list row. Clicking it selects (and activates) it. */
export function Row({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const ref = useMouse({ onClick });
  return (
    <Box ref={ref} backgroundColor={active ? c.panel : undefined} paddingX={1} overflow="hidden">
      <Text color={active ? c.brand : c.dim}>{active ? '❯ ' : '  '}</Text>
      <Box flexGrow={1} overflow="hidden">
        {children}
      </Box>
    </Box>
  );
}

export function Scroll({ onScroll, children }: { onScroll: (d: 1 | -1) => void; children: React.ReactNode }) {
  const ref = useMouse({ onScroll });
  return (
    <Box ref={ref} flexDirection="column" flexGrow={1} overflow="hidden">
      {children}
    </Box>
  );
}
