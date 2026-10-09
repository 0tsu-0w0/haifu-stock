import { Link } from 'react-router-dom';
import { useAuth } from '../app/AuthProvider';

export type EventTab = 'register' | 'history' | 'prepare' | 'closing';

const ICON: Record<EventTab | 'home', string[]> = {
  home: ['M3 11l9-7 9 7', 'M5 10v10h14V10'],
  register: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  history: ['M12 8v4l3 2', 'M3.05 11a9 9 0 1 1 .5 4', 'M3 4v5h5'],
  prepare: ['M3 7l9-4 9 4-9 4z', 'M3 7v10l9 4 9-4V7', 'M12 11v10'],
  closing: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
};

/** イベントの画面(レジ・履歴・準備・終了処理)を1タップで行き来する下のタブ */
export function EventNav({ eventId, current }: { eventId: string; current: EventTab }) {
  const { role } = useAuth();
  const tabs: [EventTab | 'home', string, string][] = [
    ['home', '/', 'ホーム'],
    ['register', `/events/${eventId}/register`, 'レジ'],
    ['history', `/events/${eventId}/history`, '履歴'],
    ...(role === 'owner'
      ? ([['prepare', `/events/${eventId}/prepare`, '準備'], ['closing', `/events/${eventId}/closing`, '終了処理']] as [EventTab, string, string][])
      : []),
  ];
  return (
    <nav className="enav" aria-label="イベントの画面">
      {tabs.map(([k, to, label]) => (
        <Link key={k} className="enav-tab" to={to} replace={k !== 'home'} aria-current={k === current ? 'page' : undefined}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {ICON[k].map((d) => <path key={d} d={d} />)}
          </svg>
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  );
}
