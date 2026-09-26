// Extracted from App.jsx unchanged in behaviour (ROADMAP FE-10: one page per change).

import { useState, useEffect } from 'react'
import { FaExclamationCircle } from 'react-icons/fa'
import { api, API_BASE } from '../api'
import { formatDateLocal } from '../dateUtils'

// formatDateLocal moved to ./dateUtils so the calendar and the statistics page
// cannot disagree about which local day an instant belongs to.

export default function CalendarPage({ user }) {
  const [userGames, setUserGames] = useState([]);
  // Same defect as the library page had, on the same endpoint: a failed load rendered
  // an empty month with no releases marked, indistinguishable from "nothing is coming
  // out", plus an unhandled rejection. Fixing one of two instances would have left the
  // identical lie one nav click away.
  const [loadError, setLoadError] = useState(false);
  const [month, setMonth] = useState(() => {
    const today = new Date();
    return { year: today.getFullYear(), month: today.getMonth() };
  });

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoadError(false);
    api.get(`${API_BASE}/user/${user.username}/games`).then(res => {
      if (cancelled) return;
      if (!Array.isArray(res.data)) throw new Error('unexpected library response');
      setUserGames(res.data);
    }).catch(() => {
      if (cancelled) return;
      setUserGames([]);
      setLoadError(true);
    });
    return () => { cancelled = true; };
  }, [user]);

  // Build a map of release dates to games
  const dateMap = {};
  userGames.forEach(game => {
    if (game.release_date) {
      dateMap[game.release_date] = dateMap[game.release_date] || [];
      dateMap[game.release_date].push(game);
    }
  });

  // Calendar grid for selected month
  const year = month?.year ?? new Date().getFullYear();
  const m = month?.month ?? new Date().getMonth();
  const firstDay = new Date(year, m, 1);
  const startDay = firstDay.getDay();

  // Build a 6-row (max) calendar grid (7 days per week)
  const calendarCells = [];
  let dayNum = 1 - startDay;
  for (let week = 0; week < 6; week++) {
    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(year, m, dayNum);
      calendarCells.push(cellDate);
      dayNum++;
    }
  }

  const today = new Date();
  const isToday = (date) =>
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();

  const isCurrentMonth = (date) => date.getMonth() === m && date.getFullYear() === year;

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const handlePrevMonth = () => {
    setMonth(prev => {
      let newMonth = prev.month - 1;
      let newYear = prev.year;
      if (newMonth < 0) {
        newMonth = 11;
        newYear--;
      }
      return { year: newYear, month: newMonth };
    });
  };
  const handleNextMonth = () => {
    setMonth(prev => {
      let newMonth = prev.month + 1;
      let newYear = prev.year;
      if (newMonth > 11) {
        newMonth = 0;
        newYear++;
      }
      return { year: newYear, month: newMonth };
    });
  };

  return (
    <div className="calendar-section">
      <div className="calendar-header">
        <button className="calendar-nav-btn" onClick={handlePrevMonth}>&lt;</button>
        <span className="calendar-month-label">{monthNames[m]} {year}</span>
        <button className="calendar-nav-btn" onClick={handleNextMonth}>&gt;</button>
      </div>
      {/* An empty calendar and an unreachable server look the same. Say which. */}
      {loadError && (
        <p className="calendar-load-error" role="alert">
          <FaExclamationCircle aria-hidden="true" /> Couldn&apos;t load your games — release
          dates below are incomplete. Your library is unchanged.
        </p>
      )}
      <div className="calendar-grid calendar-grid-full">
        {weekdayNames.map((wd) => (
          <div key={wd} className="calendar-cell calendar-weekday">{wd}</div>
        ))}
        {calendarCells.map((date, idx) => {
          const dateStr = formatDateLocal(date);
          const games = dateMap[dateStr] || [];
          return (
            <div
              key={idx}
              className={`calendar-cell${isCurrentMonth(date) ? '' : ' calendar-other-month'}${isToday(date) ? ' calendar-today' : ''}`}
            >
              <div className="calendar-date">{date.getDate()}</div>
              {games.length > 0 && (
                <div className="calendar-games-list">
                  {games.slice(0, 2).map(game => (
                    <div key={game.game_id} className="calendar-game-title-small">{game.game_name}</div>
                  ))}
                  {games.length > 2 && (
                    <div className="calendar-overflow-badge">+{games.length - 2} more</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
