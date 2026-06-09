export const formatNumber = (n: number): string => n.toLocaleString('en-US');

/** Compact money/score, e.g. 2_510_015 -> "2.51M". */
export function formatCompact(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.00$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.00$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export interface Remaining { d: number; h: number; m: number; s: number; done: boolean; }

export function splitRemaining(ms: number): Remaining {
  const clamped = Math.max(0, ms);
  const s = Math.floor(clamped / 1000);
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
    done: ms <= 0,
  };
}

export const pad2 = (n: number): string => String(n).padStart(2, '0');
