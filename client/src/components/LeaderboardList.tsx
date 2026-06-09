import { useEffect, useRef, useState, type UIEvent } from 'react';
import type { LeaderboardEntry } from '@panteon/shared';
import { RankRow } from './RankRow.js';

const ROW = 56;        // px per row
const OVERSCAN = 6;
const START_RANK = 4;  // ranks 1–3 live on the podium

/** Windowed, infinite-scroll list: only the visible rows are in the DOM (fixes the legacy freeze). */
export function LeaderboardList({ entries, meId, onSelect, hasMore, onLoadMore, scrollToRank }: {
  entries: LeaderboardEntry[];
  meId: string | null;
  onSelect: (id: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  scrollToRank: number | null;
}) {
  const rows = entries.filter((e) => e.rank >= START_RANK);
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(560);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Scroll to a rank on demand (jump-to-me).
  useEffect(() => {
    if (scrollToRank == null || !ref.current) return;
    const idx = Math.max(0, scrollToRank - START_RANK);
    ref.current.scrollTo({ top: idx * ROW - viewport / 2 + ROW, behavior: 'smooth' });
  }, [scrollToRank, viewport]);

  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewport) / ROW) + OVERSCAN);
  const visible = rows.slice(start, end);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (hasMore && el.scrollTop + el.clientHeight > el.scrollHeight - ROW * 12) onLoadMore();
  };

  return (
    <div className="list" ref={ref} onScroll={onScroll}>
      <div className="list-spacer" style={{ height: total * ROW }}>
        {visible.map((e, i) => (
          <RankRow
            key={e.playerId}
            entry={e}
            isMe={e.playerId === meId}
            onSelect={onSelect}
            style={{ position: 'absolute', top: (start + i) * ROW, left: 0, right: 0, height: ROW }}
          />
        ))}
      </div>
      {hasMore && <div className="list-loading" style={{ top: total * ROW }}>loading more…</div>}
    </div>
  );
}
