import { measureElement, type DOMElement } from 'ink';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import React, { createContext, useContext, useEffect, useRef } from 'react';

export interface MouseEvent {
  kind: 'click' | 'scroll-up' | 'scroll-down';
  x: number;
  y: number;
}

// SGR mouse reports: ESC [ < button ; col ; row (M = press, m = release)
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const PARTIAL = /\x1b(\[(<[\d;]*)?)?$/;

/**
 * Wraps process.stdin so Ink never sees mouse escape codes (they'd otherwise show up as typed text).
 * Mouse events are emitted separately; everything else is passed through untouched.
 */
export class MouseInput {
  readonly events = new EventEmitter();
  readonly stdin: NodeJS.ReadStream;
  private carry = '';
  private active = false;
  private onData = (chunk: Buffer | string) => this.handle(chunk.toString());

  constructor(private src: NodeJS.ReadStream = process.stdin) {
    const out = new PassThrough() as any;
    out.isTTY = true;
    out.setRawMode = (mode: boolean) => {
      src.setRawMode?.(mode);
      out.isRaw = mode;
      return out;
    };
    out.ref = () => (src.ref(), out);
    out.unref = () => (src.unref(), out);
    this.stdin = out;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.src.on('data', this.onData);
    this.src.resume();
    process.stdout.write('\x1b[?1000h\x1b[?1006h'); // button events, SGR encoding
  }

  /** Hands the terminal back (e.g. while `gh auth login` runs). */
  stop() {
    if (!this.active) return;
    this.active = false;
    process.stdout.write('\x1b[?1000l\x1b[?1006l');
    this.src.off('data', this.onData);
    this.src.pause();
  }

  private handle(text: string) {
    text = this.carry + text;
    this.carry = '';
    const partial = PARTIAL.exec(text);
    if (partial && partial[0].length > 1) {
      this.carry = partial[0];
      text = text.slice(0, -partial[0].length);
    }
    const rest = text.replace(SGR, (_, b: string, x: string, y: string, kind: string) => {
      const button = Number(b);
      const pos = { x: Number(x) - 1, y: Number(y) - 1 };
      if (button === 64) this.events.emit('mouse', { kind: 'scroll-up', ...pos });
      else if (button === 65) this.events.emit('mouse', { kind: 'scroll-down', ...pos });
      else if (kind === 'M' && (button & 3) === 0 && button < 32) this.events.emit('mouse', { kind: 'click', ...pos });
      return '';
    });
    if (rest) (this.stdin as unknown as PassThrough).write(rest);
  }
}

interface Region {
  ref: React.RefObject<DOMElement | null>;
  onClick?: () => void;
  onScroll?: (dir: 1 | -1) => void;
}

const MouseContext = createContext<{ input?: MouseInput; regions: Set<Region> }>({ regions: new Set() });

export function MouseProvider({ input, children }: { input?: MouseInput; children: React.ReactNode }) {
  const regions = useRef(new Set<Region>()).current;
  useEffect(() => {
    if (!input) return;
    const handler = (e: MouseEvent) => {
      // The innermost region under the pointer wins.
      let best: { r: Region; area: number } | undefined;
      for (const r of regions) {
        if (!r.ref.current) continue;
        if (e.kind === 'click' ? !r.onClick : !r.onScroll) continue;
        const m = measureElement(r.ref.current);
        if (e.x < m.x || e.x >= m.x + m.width || e.y < m.y || e.y >= m.y + m.height) continue;
        const area = m.width * m.height;
        if (!best || area < best.area) best = { r, area };
      }
      if (!best) return;
      if (e.kind === 'click') best.r.onClick!();
      else best.r.onScroll!(e.kind === 'scroll-up' ? -1 : 1);
    };
    input.events.on('mouse', handler);
    return () => void input.events.off('mouse', handler);
  }, [input]);
  return <MouseContext.Provider value={{ input, regions }}>{children}</MouseContext.Provider>;
}

/** Makes a Box clickable/scrollable: `<Box ref={useMouse({ onClick })}>`. */
export function useMouse(handlers: { onClick?: () => void; onScroll?: (dir: 1 | -1) => void }) {
  const { regions } = useContext(MouseContext);
  const ref = useRef<DOMElement | null>(null);
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const region: Region = {
      ref,
      onClick: handlers.onClick && (() => latest.current.onClick?.()),
      onScroll: handlers.onScroll && ((d) => latest.current.onScroll?.(d)),
    };
    regions.add(region);
    return () => void regions.delete(region);
  }, [!!handlers.onClick, !!handlers.onScroll]);
  return ref;
}

export function useMouseInput() {
  return useContext(MouseContext).input;
}
