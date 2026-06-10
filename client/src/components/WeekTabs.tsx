import type { ArchiveWeek } from '../api.js';
import { formatCompact } from '../lib/format.js';

export function WeekTabs({ archive, selected, liveWeekId, onSelect }: {
  archive: ArchiveWeek[];
  selected: 'live' | string;
  liveWeekId: string | undefined;
  onSelect: (week: 'live' | string) => void;
}) {
  return (
    <div className="tabs">
      <button
        className={`tab${selected === 'live' ? ' is-active' : ''}`}
        onClick={() => onSelect('live')}
      >
        <span className="tab-dot" /> This Week
        {liveWeekId && <span className="tab-week">{liveWeekId}</span>}
      </button>
      {archive.map((w) => (
        <button
          key={w.weekId}
          className={`tab${selected === w.weekId ? ' is-active' : ''}`}
          onClick={() => onSelect(w.weekId)}
        >
          {w.weekId}
          <span className="tab-pool">◈ {formatCompact(w.poolTotal)}</span>
        </button>
      ))}
    </div>
  );
}
