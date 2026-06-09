import type { CSSProperties } from 'react';
import type { LeaderboardEntry } from '@panteon/shared';
import { Avatar } from './Avatar.js';
import { formatNumber } from '../lib/format.js';

const MEDAL: Record<number, string> = { 1: 'tier-gold', 2: 'tier-silver', 3: 'tier-bronze' };

export function RankRow({ entry, isMe, onSelect, style }: {
  entry: LeaderboardEntry;
  isMe: boolean;
  onSelect: (id: string) => void;
  style?: CSSProperties;
}) {
  return (
    <button
      className={`row ${MEDAL[entry.rank] ?? ''}${isMe ? ' is-me' : ''}`}
      style={style}
      onClick={() => onSelect(entry.playerId)}
    >
      <span className="row-rank">{entry.rank <= 3 ? '★' : `#${entry.rank}`}</span>
      <span className="row-rankn">{entry.rank}</span>
      <Avatar playerId={entry.playerId} name={entry.displayName} size={34} />
      <span className="row-name">
        {entry.displayName ?? entry.playerId.slice(0, 8)}
        {isMe && <span className="row-you">YOU</span>}
      </span>
      <span className="row-score">{formatNumber(entry.totalEarned)}</span>
    </button>
  );
}
