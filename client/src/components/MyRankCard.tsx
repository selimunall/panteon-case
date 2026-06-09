import type { PlayerRankView } from '@panteon/shared';
import { Avatar } from './Avatar.js';
import { formatNumber } from '../lib/format.js';

export function MyRankCard({ view, notRanked, onJump, onPick }: {
  view: PlayerRankView | null;
  notRanked: boolean;
  onJump: () => void;
  onPick: (id: string) => void;
}) {
  if (notRanked) {
    return (
      <div className="me-card is-empty">
        <span className="me-eyebrow">Your standing</span>
        <p className="me-empty">You haven't earned this week. Start playing to climb onto the board.</p>
      </div>
    );
  }
  if (!view) {
    return <div className="me-card is-loading"><span className="me-eyebrow">Your standing</span><div className="skeleton-line" /></div>;
  }

  const me = view.player;
  const above = view.neighbours.filter((n) => n.rank < me.rank);
  const below = view.neighbours.filter((n) => n.rank > me.rank);

  return (
    <div className="me-card">
      <div className="me-head">
        <span className="me-eyebrow">Your standing</span>
        <button className="me-jump" onClick={onJump}>Jump to me ↧</button>
      </div>
      <div className="me-hero">
        <Avatar playerId={me.playerId} name={me.displayName} size={52} />
        <div className="me-meta">
          <span className="me-name">{me.displayName ?? me.playerId.slice(0, 8)}</span>
          <span className="me-score">{formatNumber(me.totalEarned)}</span>
        </div>
        <div className="me-rankbadge">
          <span className="me-rank-hash">#</span>
          <span className="me-rank-n">{me.rank}</span>
        </div>
      </div>

      {view.inTop100 ? (
        <p className="me-status">You're in the top 100 — on track for a reward. 🏆</p>
      ) : (
        <div className="me-window">
          {above.map((n) => <Neighbour key={n.playerId} rank={n.rank} name={n.displayName ?? n.playerId.slice(0, 8)} score={n.totalEarned} id={n.playerId} onPick={onPick} />)}
          <Neighbour rank={me.rank} name={me.displayName ?? me.playerId.slice(0, 8)} score={me.totalEarned} id={me.playerId} onPick={onPick} self />
          {below.map((n) => <Neighbour key={n.playerId} rank={n.rank} name={n.displayName ?? n.playerId.slice(0, 8)} score={n.totalEarned} id={n.playerId} onPick={onPick} />)}
        </div>
      )}
    </div>
  );
}

function Neighbour({ rank, name, score, id, onPick, self }: {
  rank: number; name: string; score: number; id: string; onPick: (id: string) => void; self?: boolean;
}) {
  return (
    <button className={`nb${self ? ' is-me' : ''}`} onClick={() => onPick(id)}>
      <span className="nb-rank">{rank}</span>
      <Avatar playerId={id} name={name} size={26} />
      <span className="nb-name">{name}{self && <span className="row-you">YOU</span>}</span>
      <span className="nb-score">{formatNumber(score)}</span>
    </button>
  );
}
