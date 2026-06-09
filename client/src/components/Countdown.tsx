import { useCountdown } from '../hooks.js';
import { pad2, splitRemaining } from '../lib/format.js';

export function Countdown({ endsAt }: { endsAt: string | undefined }) {
  const remaining = useCountdown(endsAt);
  const t = splitRemaining(remaining);
  const cell = (value: string, label: string) => (
    <div className="cd-cell">
      <span className="cd-value">{value}</span>
      <span className="cd-label">{label}</span>
    </div>
  );
  return (
    <div className={`countdown${t.done ? ' is-resetting' : ''}`}>
      <span className="cd-eyebrow">{t.done ? 'Distributing rewards' : 'Resets in'}</span>
      <div className="cd-grid">
        {cell(pad2(t.d), 'days')}
        <span className="cd-sep">:</span>
        {cell(pad2(t.h), 'hrs')}
        <span className="cd-sep">:</span>
        {cell(pad2(t.m), 'min')}
        <span className="cd-sep">:</span>
        {cell(pad2(t.s), 'sec')}
      </div>
    </div>
  );
}
