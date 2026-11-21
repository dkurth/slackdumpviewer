import { Clock, Hash, Lock, MessageSquare, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Channel, type FileHit, type Message as Msg } from './api';
import { Avatar } from './Avatar';
import { Message } from './Message';
import { internalPath, navigate } from './router';
import { FileTable } from './SearchPage';
import { ChannelIcon } from './Sidebar';
import { lsGet, lsSet, useStore } from './store';
import { useUI } from './ui';
import { altKey, formatShortDate, fuzzyScore, isMac, modKey } from './util';

export function Modal({ title, onClose, children, wide, className }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={'modal' + (wide ? ' wide' : '') + (className ? ' ' + className : '')} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ---------- recent conversations ----------

export function recentConvs(): string[] {
  try {
    return JSON.parse(lsGet('sdv.recentConvs') || '[]');
  } catch {
    return [];
  }
}
export function pushRecentConv(id: string) {
  lsSet('sdv.recentConvs', JSON.stringify([id, ...recentConvs().filter((x) => x !== id)].slice(0, 30)));
}

// ---------- quick switcher ----------

interface SwitchItem {
  key: string;
  label: string;
  sub?: string;
  icon: ReactNode;
  score: number;
  go: () => void;
}

export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ui = useUI();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items = useMemo<SwitchItem[]>(() => {
    const recent = recentConvs();
    const out: SwitchItem[] = [];
    const internal = q.trim() && internalPath(q.trim(), store.teamHost);
    if (internal) {
      out.push({ key: 'url', label: 'Open Slack link', sub: q.trim(), icon: <MessageSquare size={16} />, score: 1e6, go: () => navigate(internal) });
    }
    const imByUser = new Map<string, Channel>();
    for (const c of store.channels.values()) if (c.kind === 'im' && c.im_user) imByUser.set(c.im_user, c);
    for (const c of store.channels.values()) {
      const label = store.channelLabel(c);
      const r = recent.indexOf(c.id);
      const base = q ? fuzzyScore(q, label) : r >= 0 ? 1000 - r : -1;
      if (base < 0) continue;
      const boost = (r >= 0 ? 50 - r : 0) + (c.is_member ? 20 : 0) - (c.is_archived ? 40 : 0) + (c.count > 0 ? 10 : -100);
      out.push({
        key: c.id,
        label,
        sub: c.is_archived ? 'archived' : c.kind === 'im' ? store.person(c.im_user).fullName : c.kind === 'mpim' ? 'group DM' : c.purpose,
        icon: <ChannelIcon c={c} />,
        score: base + boost,
        go: () => ui.openChannel(c.id),
      });
    }
    if (q) {
      for (const u of store.users.values()) {
        if (imByUser.has(u.id)) continue;
        const s = Math.max(fuzzyScore(q, u.real_name || ''), fuzzyScore(q, u.display_name || ''), fuzzyScore(q, u.name));
        if (s < 0) continue;
        out.push({ key: 'u' + u.id, label: store.person(u.id).name, sub: 'Profile', icon: <Avatar p={store.person(u.id)} size={20} />, score: s - 30, go: () => ui.openProfile(u.id) });
      }
      out.push({ key: 'search', label: `Search for “${q}”`, icon: <Search size={16} />, score: -1e6, go: () => ui.search(q) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 50);
  }, [q, store, ui]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const pick = (i: number) => {
    const it = items[i];
    if (!it) return;
    onClose();
    it.go();
  };
  return (
    <div className="modal-backdrop switcher-backdrop" onMouseDown={onClose}>
      <div className="switcher" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Jump to">
        <input
          autoFocus
          className="switcher-input"
          placeholder="Jump to… (channels, people, or paste a Slack link)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            else if (e.key === 'Enter') (e.preventDefault(), pick(sel));
            else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), onClose());
          }}
        />
        <div className="switcher-list" ref={listRef}>
          {!q && <div className="switcher-heading">Recent</div>}
          {items.map((it, i) => (
            <div key={it.key} className={'switcher-item' + (i === sel ? ' sel' : '')} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), pick(i))}>
              <span className="switcher-icon">{it.icon}</span>
              <span className="switcher-label">{it.label}</span>
              {it.sub && <span className="switcher-sub">{it.sub}</span>}
              {i === sel && <kbd className="switcher-enter">↵</kbd>}
            </div>
          ))}
          {items.length === 0 && <div className="empty-state small">{q ? 'No matches' : 'Type to find a conversation or person'}</div>}
        </div>
        <div className="switcher-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> to navigate
          </span>
          <span>
            <kbd>↵</kbd> to select
          </span>
          <span>
            <kbd>esc</kbd> to dismiss
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------- keyboard shortcuts ----------

export const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Navigation',
    [
      [`${modKey} K`, 'Jump to a conversation (quick switcher)'],
      [`${altKey} ↑ / ${altKey} ↓`, 'Previous / next conversation'],
      [`${modKey} [ / ${modKey} ]`, 'Back / forward in history'],
      [`${modKey} ⇧ L`, 'Browse channels'],
      [`${modKey} ⇧ K`, 'Browse direct messages'],
      [`${modKey} ⇧ E`, 'People directory'],
      [`${modKey} ⇧ I`, 'Conversation details'],
      [`${modKey} ⇧ D`, 'Show / hide sidebar'],
      [`${modKey} .`, 'Show / hide the right pane'],
      ['F6 / ⇧ F6', 'Move focus between sidebar, messages and thread'],
    ],
  ],
  [
    'Search',
    [
      [`${modKey} G`, 'Search'],
      [`${modKey} F`, 'Search in the current conversation'],
    ],
  ],
  [
    'Messages',
    [
      ['↑ / ↓', 'Move between messages'],
      ['Enter or T', 'Open the focused message’s thread'],
      ['L', 'Copy link to the focused message'],
      ['Page Up / Page Down', 'Scroll'],
      ['Home / End', 'Jump to the beginning / most recent'],
      ['Esc', 'Close the thread, dialog, or menu'],
    ],
  ],
  ['Help', [[`${modKey} /`, 'Show keyboard shortcuts']]],
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="shortcuts">
        {SHORTCUTS.map(([sec, rows]) => (
          <section key={sec}>
            <h3>{sec}</h3>
            {rows.map(([k, d]) => (
              <div key={k} className="shortcut-row">
                <span>{d}</span>
                <span className="keys">
                  {k.split(' ').map((p, i) => (p === '/' ? <span key={i}> / </span> : <kbd key={i}>{p}</kbd>))}
                </span>
              </div>
            ))}
          </section>
        ))}
        {!isMac && <p className="note">Some keys (Ctrl+T, Ctrl+N, Ctrl+W) belong to the browser and can't be used here.</p>}
      </div>
    </Modal>
  );
}

// ---------- preferences ----------

export function Prefs({ onClose }: { onClose: () => void }) {
  const { prefs, setPrefs } = useStore();
  return (
    <Modal title="Preferences" onClose={onClose}>
      <div className="prefs">
        <label className="pref-row">
          <span>Theme</span>
          <select value={prefs.theme} onChange={(e) => setPrefs({ theme: e.target.value as 'system' })}>
            <option value="system">Sync with OS</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="pref-row">
          <span>
            Show suggested aliases
            <small>Show old accounts with their suggested (unconfirmed) identity, marked “old account?”.</small>
          </span>
          <input type="checkbox" checked={prefs.showSuggestedAliases} onChange={(e) => setPrefs({ showSuggestedAliases: e.target.checked })} />
        </label>
        <label className="pref-row">
          <span>
            Load images from the web
            <small>Link previews and bot messages reference images on other sites. Off keeps the viewer fully offline.</small>
          </span>
          <input type="checkbox" checked={prefs.externalImages} onChange={(e) => setPrefs({ externalImages: e.target.checked })} />
        </label>
        <label className="pref-row">
          <span>24-hour clock</span>
          <input type="checkbox" checked={prefs.clock24} onChange={(e) => setPrefs({ clock24: e.target.checked })} />
        </label>
      </div>
    </Modal>
  );
}

// ---------- browse ----------

export function BrowseChannels({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ui = useUI();
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState<'name' | 'recent' | 'size'>('name');
  const list = useMemo(() => {
    let l = [...store.channels.values()].filter((c) => (c.kind === 'public' || c.kind === 'private') && (archived || !c.is_archived));
    if (q) l = l.filter((c) => fuzzyScore(q, c.name) >= 0 || (c.purpose || '').toLowerCase().includes(q.toLowerCase()));
    return l.sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name) : sort === 'recent' ? parseFloat(b.latest_ts || '0') - parseFloat(a.latest_ts || '0') : b.count - a.count,
    );
  }, [store, q, archived, sort]);
  return (
    <Modal title="All channels" onClose={onClose} wide>
      <div className="browse-tools">
        <input autoFocus className="browse-search" placeholder="Search by channel name or description" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value as 'name')}>
          <option value="name">A–Z</option>
          <option value="recent">Most recent</option>
          <option value="size">Most messages</option>
        </select>
      </div>
      <div className="browse-count">{list.length} channels</div>
      <div className="browse-list">
        {list.map((c) => (
          <button key={c.id} className="browse-row" onClick={() => (onClose(), ui.openChannel(c.id))}>
            <span className="browse-name">
              {c.kind === 'private' ? <Lock size={14} /> : <Hash size={14} />} {c.name}
              {c.is_archived && <span className="badge">archived</span>}
              {c.is_member && <span className="badge badge-joined">joined</span>}
            </span>
            <span className="browse-sub">
              {c.count.toLocaleString()} messages
              {c.latest_ts ? ` · last ${formatShortDate(c.latest_ts)}` : ''}
              {c.purpose ? ` · ${c.purpose}` : ''}
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function BrowseDMs({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ui = useUI();
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    let l = [...store.channels.values()].filter((c) => (c.kind === 'im' || c.kind === 'mpim') && c.count > 0);
    if (q) l = l.filter((c) => fuzzyScore(q, store.channelLabel(c)) >= 0);
    return l.sort((a, b) => parseFloat(b.latest_ts || '0') - parseFloat(a.latest_ts || '0'));
  }, [store, q]);
  return (
    <Modal title="Direct messages" onClose={onClose} wide>
      <div className="browse-tools">
        <input autoFocus className="browse-search" placeholder="Find a DM" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="browse-list">
        {list.map((c) => (
          <button key={c.id} className="browse-row dm-row" onClick={() => (onClose(), ui.openChannel(c.id))}>
            <span className="browse-name">
              <ChannelIcon c={c} /> {store.channelLabel(c)}
            </span>
            <span className="browse-sub">
              <Clock size={12} /> {c.latest_ts ? formatShortDate(c.latest_ts) : ''} · {c.count.toLocaleString()} messages
            </span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export function People({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const ui = useUI();
  const [q, setQ] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const list = useMemo(() => {
    let l = [...store.users.values()].filter((u) => showDeleted || !u.deleted);
    if (q) l = l.filter((u) => Math.max(fuzzyScore(q, u.real_name || ''), fuzzyScore(q, u.display_name || ''), fuzzyScore(q, u.name), fuzzyScore(q, u.title || '')) >= 0);
    return l.sort((a, b) => store.person(a.id).name.localeCompare(store.person(b.id).name));
  }, [store, q, showDeleted]);
  return (
    <Modal title="People" onClose={onClose} wide>
      <div className="browse-tools">
        <input autoFocus className="browse-search" placeholder="Search for people" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Include deactivated
        </label>
      </div>
      <div className="people-grid">
        {list.map((u) => (
          <button key={u.id} className="person-card" onClick={() => (onClose(), ui.openProfile(u.id))}>
            <Avatar p={store.person(u.id)} size={96} />
            <span className="person-name">{store.person(u.id).name}</span>
            <span className="person-title">{u.deleted ? 'Deactivated' : u.title || u.real_name}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------- conversation details ----------

export function ChannelDetails({ id, onClose }: { id: string; onClose: () => void }) {
  const store = useStore();
  const ui = useUI();
  const c = store.channels.get(id);
  const [tab, setTab] = useState<'about' | 'members' | 'pins' | 'files'>('about');
  const [info, setInfo] = useState<{ pins: Msg[]; file_count: number } | null>(null);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [fileTotal, setFileTotal] = useState<number | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  useEffect(() => {
    api.conversation(id).then(setInfo);
  }, [id]);
  useEffect(() => {
    if (tab !== 'files' || fileTotal !== null) return;
    setLoadingFiles(true);
    api
      .conversationFiles(id)
      .then((r) => (setFiles(r.files || []), setFileTotal(r.total)))
      .finally(() => setLoadingFiles(false));
  }, [tab, id, fileTotal]);
  if (!c) return null;
  const members = c.members || [];
  const dm = c.kind === 'im' || c.kind === 'mpim';
  return (
    <Modal
      title={
        <>
          <ChannelIcon c={c} /> {store.channelLabel(c)}
        </>
      }
      onClose={onClose}
      wide
      className="details-modal"
    >
      <div className="tabs">
        {(['about', 'members', 'pins', 'files'] as const).map((t) => (
          <button key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>
            {t === 'about' ? 'About' : t === 'members' ? `Members ${members.length || ''}` : t === 'pins' ? `Pins ${info ? info.pins.length : ''}` : `Files ${info ? info.file_count : ''}`}
          </button>
        ))}
      </div>
      {tab === 'about' && (
        <div className="about">
          {!dm && (
            <>
              <div className="about-block">
                <h4>Channel name</h4>
                <p>
                  {c.kind === 'private' ? '🔒 ' : '# '}
                  {c.name} {c.is_archived && <span className="badge">archived</span>}
                </p>
              </div>
              <div className="about-block">
                <h4>Topic</h4>
                <p>{c.topic || <span className="muted">No topic</span>}</p>
              </div>
              <div className="about-block">
                <h4>Description</h4>
                <p>{c.purpose || <span className="muted">No description</span>}</p>
              </div>
            </>
          )}
          <div className="about-block">
            <h4>In the archive</h4>
            <p>
              {c.count.toLocaleString()} messages
              {c.total > c.count ? ` (+${(c.total - c.count).toLocaleString()} thread replies)` : ''}
              {c.first_ts ? `, from ${formatShortDate(c.first_ts)}` : ''}
              {c.latest_ts ? ` to ${formatShortDate(c.latest_ts)}` : ''}
            </p>
          </div>
          {c.created ? (
            <div className="about-block">
              <h4>Created</h4>
              <p>
                {c.creator ? `by ${store.person(c.creator).name} ` : ''}on {formatShortDate(c.created)}
              </p>
            </div>
          ) : null}
          <div className="about-block">
            <h4>Conversation ID</h4>
            <p className="mono">{c.id}</p>
          </div>
        </div>
      )}
      {tab === 'members' && (
        <div className="member-list">
          {members.length === 0 && <div className="empty-state small">No member list in the archive.</div>}
          {members.map((m) => {
            const p = store.person(m);
            return (
              <button key={m} className="member-row" onClick={() => (onClose(), ui.openProfile(m))}>
                <Avatar p={p} size={36} />
                <span className="member-name">
                  {p.name}
                  {m === store.me ? ' (you)' : ''}
                </span>
                <span className="member-sub">{p.user?.title || (p.unknown ? m : '')}</span>
              </button>
            );
          })}
        </div>
      )}
      {tab === 'pins' && (
        <div className="pins">
          {!info && <div className="empty-state small">Loading…</div>}
          {info?.pins.length === 0 && <div className="empty-state small">Nothing pinned.</div>}
          {info?.pins.map((m) => (
            <div key={m.ts} className="search-result" onClick={() => (onClose(), ui.openChannel(m._ch, m.ts))}>
              <Message m={m} showChannel={false} />
            </div>
          ))}
        </div>
      )}
      {tab === 'files' && (
        <FileTable
          files={files}
          total={fileTotal}
          loading={loadingFiles}
          store={store}
          ui={{ ...ui, openChannel: (...a) => (onClose(), ui.openChannel(...a)), openThread: (...a) => (onClose(), ui.openThread(...a)) }}
          onMore={() => {
            setLoadingFiles(true);
            api
              .conversationFiles(id, files.length)
              .then((r) => setFiles((f) => [...f, ...(r.files || [])]))
              .finally(() => setLoadingFiles(false));
          }}
        />
      )}
    </Modal>
  );
}

// ---------- profile ----------

export function ProfilePane({ id, onClose }: { id: string; onClose: () => void }) {
  const store = useStore();
  const ui = useUI();
  const p = store.person(id);
  const u = p.user;
  const alias = store.aliases[id];
  const dm = [...store.channels.values()].find((c) => c.kind === 'im' && c.im_user === id);
  const localTime = u?.tz
    ? (() => {
        try {
          return new Date().toLocaleTimeString(undefined, { timeZone: u.tz, hour: 'numeric', minute: '2-digit' });
        } catch {
          return '';
        }
      })()
    : '';
  const others = Object.entries(store.aliases)
    .filter(([, e]) => e.maps_to === id && e.status === 'confirmed')
    .map(([k]) => k);
  return (
    <aside className="side-pane profile-pane" aria-label="Profile">
      <header className="pane-header">
        <div className="pane-title">Profile</div>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <X size={18} />
        </button>
      </header>
      <div className="pane-body profile-body">
        <div className="profile-avatar">
          <Avatar p={p} size={240} />
        </div>
        <h2 className="profile-name">
          {p.name}
          {p.deleted && <span className="badge">deactivated</span>}
        </h2>
        {p.fullName && <div className="profile-real">{p.fullName}</div>}
        {u?.title && <div className="profile-title">{u.title}</div>}
        {p.oldAccount && (
          <div className="profile-note">
            {p.suggested ? 'Suggested match' : 'Old account'} <span className="mono">{id}</span> {u ? `→ ${u.name}` : ''}
          </div>
        )}
        {p.unknown && (
          <div className="profile-note">
            This account (<span className="mono">{id}</span>) has no profile in the archive — probably an account from before a workspace merge.{' '}
            <button className="link-btn" onClick={() => (onClose(), navigate({ kind: 'unknown-users' }))}>
              Identify it
            </button>
            {alias && alias.status === 'suggested' && <> (suggestion: {alias.name || store.person(alias.maps_to).name})</>}
          </div>
        )}
        <div className="profile-actions">
          {dm && (
            <button className="btn" onClick={() => ui.openChannel(dm.id)}>
              <MessageSquare size={15} /> Direct messages
            </button>
          )}
          <button className="btn" onClick={() => ui.search(`from:${u ? '@' + u.name : id}`)}>
            <Search size={15} /> Messages from {p.name.split(' ')[0]}
          </button>
        </div>
        <dl className="profile-fields">
          {localTime && (
            <>
              <dt>Local time</dt>
              <dd>
                {localTime} {u?.tz_label ? `(${u.tz_label})` : ''}
              </dd>
            </>
          )}
          {u?.name && (
            <>
              <dt>Username</dt>
              <dd>@{u.name}</dd>
            </>
          )}
          {u?.email && (
            <>
              <dt>Email</dt>
              <dd>
                <a className="link" href={`mailto:${u.email}`}>
                  {u.email}
                </a>
              </dd>
            </>
          )}
          {u?.phone && (
            <>
              <dt>Phone</dt>
              <dd>{u.phone}</dd>
            </>
          )}
          <dt>Member ID</dt>
          <dd className="mono">{u?.id || id}</dd>
          {others.length > 0 && (
            <>
              <dt>Old accounts</dt>
              <dd className="mono">{others.join(', ')}</dd>
            </>
          )}
        </dl>
      </div>
    </aside>
  );
}
