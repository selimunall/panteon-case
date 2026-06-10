import { useCallback, useEffect, useState } from 'react';
import './App.css';
import { fetchPage, postEarn } from './api.js';
import { useMyRank, usePages, useStatus, useTop100 } from './hooks.js';
import { PrizePoolBanner } from './components/PrizePoolBanner.js';
import { Countdown } from './components/Countdown.js';
import { Podium } from './components/Podium.js';
import { MyRankCard } from './components/MyRankCard.js';
import { LeaderboardList } from './components/LeaderboardList.js';

const ME_KEY = 'panteon.me';

export default function App() {
  const status = useStatus();
  const top = useTop100();
  const pages = usePages();

  const [meId, setMeId] = useState<string | null>(() => localStorage.getItem(ME_KEY));
  const { view, notRanked, refresh } = useMyRank(meId);
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

  // Auto-pick a player on first visit so "your standing" is populated.
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
      refresh(); // immediate feedback; polling keeps the rest fresh
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

  const top3 = (top.data ?? []).slice(0, 3);

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
          <span className="week-chip">{status.data?.weekId ?? '—'}</span>
          <button
            className={`btn-earn${earning ? ' is-earning' : ''}`}
            onClick={() => void earn()}
            disabled={!meId || !status.data}
          >
            <span className="earn-bolt">⚡</span> Earn
          </button>
          <button className="btn-surprise" onClick={() => void surprise()}>⚄ Surprise me</button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-left">
          <PrizePoolBanner pool={status.data?.pool ?? 0} />
          <Countdown endsAt={status.data?.endsAt} />
        </div>
        <div className="hero-right">
          <MyRankCard view={view} notRanked={notRanked} onJump={() => void jumpToMe()} onPick={pick} />
        </div>
      </section>

      <section className="podium-wrap">
        <div className="section-head"><h2>The Podium</h2><span>Top earners take 20 / 15 / 10%</span></div>
        {top.loading && top3.length === 0 ? <div className="podium-skeleton" /> : <Podium top3={top3} meId={meId} onSelect={pick} />}
      </section>

      <section className="board">
        <div className="section-head"><h2>The Climb</h2><span>Ranks 4 – {pages.cap} · scroll to explore</span></div>
        <div className="board-cols"><span>#</span><span /><span>Player</span><span>Earned</span></div>
        <LeaderboardList
          entries={pages.entries}
          meId={meId}
          onSelect={pick}
          hasMore={pages.hasMore}
          onLoadMore={pages.loadMore}
          scrollToRank={scrollToRank}
        />
      </section>

      <footer className="footer">
        <span>Live · refreshes every 3s</span>
        <span>Redis · Postgres · MongoDB</span>
      </footer>
    </div>
  );
}
