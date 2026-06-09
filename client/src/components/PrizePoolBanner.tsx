import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '../lib/format.js';

/** Animated count-up to the live prize pool. */
function useCountUp(target: number, ms = 900): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}

export function PrizePoolBanner({ pool }: { pool: number }) {
  const value = useCountUp(pool);
  return (
    <div className="pool">
      <span className="pool-eyebrow">Weekly prize pool</span>
      <div className="pool-figure">
        <span className="pool-coin">◈</span>
        <span className="pool-amount">{formatNumber(value)}</span>
      </div>
      <span className="pool-note">2% of everything earned this week · top 100 share it</span>
    </div>
  );
}
