import { useCallback, useEffect, useState } from 'react';
import './App.css';
import { fetchPage, postEarn } from './api.js';
import { useArchive, useMyHistory, useMyRank, usePages, useSnapshot, useStatus, useTop100 } from './hooks.js';
import { PrizePoolBanner } from './components/PrizePoolBanner.js';
import { Countdown } from './components/Countdown.js';
import { Podium } from './components/Podium.js';
import { MyRankCard } from './components/MyRankCard.js';
import { MyHistoryCard } from './components/MyHistoryCard.js';
import { LeaderboardList } from './components/LeaderboardList.js';
import { WeekTabs } from './components/WeekTabs.js';

const ME_KEY = 'panteon.me';

export default function App() {
  const status = useStatus();
  const top = useTop100();
  const pages = usePages();
  const archive = useArchive();

  const [meId, setMeId] = useState<string | null>(() => localStorage.getItem(ME_KEY));
  const [week, setWeek] = useState<'live' | string>('live');
  const isLive = week === 'live';

  const { view, notRanked, refresh } = useMyRank(isLive ? meId : null);
  const snapshot = useSnapshot(isLive ? null : week);
  const myHistory = useMyHistory(isLive ? null : week, meId);

  const [scrollToRank, setScrollToRank] = useState<number | null>(null);
  const [earning, setEarning] = useState(false);

  const pick = useCallback((id: string) => {
    setMeId(id);
    localStorage.setItem(ME_KEY, id);
  }, []);

  const surprise = useCallback(async () => {
    const cap = pages.cap || 1000;
    const offset = Math.floor(Math.random() * cap);
    const r = await fetchPage(offset, 1);
    if (r.entries[0]) pick(r.entries[0].playerId);
  }, [pages.cap, pick]);

  useEffect(() => {
    if (!meId) void surprise();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const earn = useCallback(async () => {
    if (!meId || !status.data) return;
    setEarning(true);
    const amount = 20000 + Math.floor(Math.random() * 40000);
    try {
      await postEarn(meId, amount, status.data.weekId);
      refresh();
    } finally {
      setTimeout(() => setEarning(false), 220);
    }
  }, [meId, status.data, refresh]);

  const jumpToMe = useCallback(async () => {
    const rank = view?.player.rank;
    if (!rank) return;
    await pages.loadUntil(rank + 4);
    setScrollToRank(rank);
    setTimeout(() => setScrollToRank(null), 600);
  }, [view, pages]);

  const top3 = isLive ? (top.data ?? []).slice(0, 3) : (snapshot?.champions ?? []).slice(0, 3);
  const listEntries = isLive ? pages.entries : (snapshot?.champions ?? []);
  const headerPool = isLive ? (status.data?.pool ?? 0) : (snapshot?.poolTotal ?? 0);
  const cap = isLive ? pages.cap : 100;

  return (
    <div className="app">
      <div className="bg-grain" aria-hidden />
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">▰▰</span>
          <span className="brand-name">PANTEON</span>
          <span className="brand-sub">Weekly Arena</span>
        </div>
        <div className="topbar-right">
          <span className="week-chip">{isLive ? (status.data?.weekId ?? '—') : week}</span>
          <button
            className={`btn-earn${earning ? ' is-earning' : ''}`}
            onClick={() => void earn()}
            disabled={!isLive || !meId || !status.data}
          >
            <span className="earn-bolt">⚡</span> Earn
          </button>
          <button className="btn-surprise" onClick={() => void surprise()}>⚄ Surprise me</button>
        </div>
      </header>

      <WeekTabs archive={archive} selected={week} liveWeekId={status.data?.weekId} onSelect={setWeek} />

      <section className="hero">
        <div className="hero-left">
          <PrizePoolBanner pool={headerPool} closed={!isLive} />
          {isLive
            ? <Countdown endsAt={status.data?.endsAt} />
            : <div className="closed-badge"><span className="cd-eyebrow">Closed</span><span className="closed-when">{week} · rewards distributed</span></div>}
        </div>
        <div className="hero-right">
          {isLive
            ? <MyRankCard view={view} notRanked={notRanked} onJump={() => void jumpToMe()} onPick={pick} />
            : <MyHistoryCard me={myHistory} />}
        </div>
      </section>

      <section className="podium-wrap">
        <div className="section-head"><h2>{isLive ? 'The Podium' : 'Champions'}</h2><span>Top earners take 20 / 15 / 10%</span></div>
        {top3.length === 0 ? <div className="podium-skeleton" /> : <Podium top3={top3} meId={meId} onSelect={pick} />}
      </section>

      <section className="board">
        <div className="section-head"><h2>{isLive ? 'The Climb' : 'Final standings'}</h2><span>Ranks 4 – {cap}{isLive ? ' · scroll to explore' : ''}</span></div>
        <div className="board-cols"><span>#</span><span /><span>Player</span><span>Earned</span></div>
        <LeaderboardList
          entries={listEntries}
          meId={meId}
          onSelect={pick}
          hasMore={isLive && pages.hasMore}
          onLoadMore={isLive ? pages.loadMore : () => {}}
          scrollToRank={isLive ? scrollToRank : null}
        />
      </section>

      <footer className="footer">
        <span>{isLive ? 'Live · refreshes every 3s' : 'Archived week · final results'}</span>
        <span>Redis · Postgres · MongoDB</span>
      </footer>
    </div>
  );
}
