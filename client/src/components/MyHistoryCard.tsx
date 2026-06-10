import type { MyHistory } from '../api.js';
import { formatNumber } from '../lib/format.js';

export function MyHistoryCard({ me }: { me: MyHistory | null }) {
  if (!me) {
    return <div className="me-card is-loading"><span className="me-eyebrow">Your result</span><div className="skeleton-line" /></div>;
  }
  if (!me.played) {
    return (
      <div className="me-card is-empty">
        <span className="me-eyebrow">Your result · {me.weekId}</span>
        <p className="me-empty">You didn't play in {me.weekId}.</p>
      </div>
    );
  }

  const won = me.reward > 0;
  return (
    <div className={`me-card${won ? ' is-winner' : ''}`}>
      <span className="me-eyebrow">Your result · {me.weekId}</span>
      <div className="me-hero">
        <div className="me-rankbadge hist">
          <span className="me-rank-hash">#</span>
          <span className="me-rank-n">{me.rank}</span>
        </div>
        <div className="me-meta">
          <span className="me-name">{formatNumber(me.totalEarned)}</span>
          <span className="me-score">final score</span>
        </div>
      </div>
      {won ? (
        <div className="me-reward">
          <span className="me-reward-label">You won</span>
          <span className="me-reward-amount">◈ {formatNumber(me.reward)}</span>
          <span className="me-reward-tag">🏆 top 100</span>
        </div>
      ) : (
        <p className="me-status">Finished #{me.rank} — just outside the top-100 rewards. Climb next week!</p>
      )}
    </div>
  );
}
