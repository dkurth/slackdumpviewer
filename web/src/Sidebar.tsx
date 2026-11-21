import { Archive, AtSign, ChevronDown, ChevronRight, Hash, Keyboard, Lock, Search, Settings, UserX, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Channel } from './api';
import { Avatar } from './Avatar';
import { lsGet, lsSet, useStore, type Store } from './store';
import { modKey } from './util';

export interface Section {
  id: string;
  title: string;
  items: Channel[];
  collapsedByDefault?: boolean;
  limit?: number;
}

export function buildSections(s: Store): Section[] {
  const all = [...s.channels.values()];
  const byName = (a: Channel, b: Channel) => s.channelLabel(a).localeCompare(s.channelLabel(b));
  const byRecent = (a: Channel, b: Channel) => parseFloat(b.latest_ts || '0') - parseFloat(a.latest_ts || '0');
  const isChan = (c: Channel) => c.kind === 'public' || c.kind === 'private';
  return [
    { id: 'channels', title: 'Channels', items: all.filter((c) => isChan(c) && !c.is_archived && (c.is_member || c.kind === 'private')).sort(byName) },
    { id: 'dms', title: 'Direct messages', items: all.filter((c) => (c.kind === 'im' || c.kind === 'mpim') && c.count > 0).sort(byRecent), limit: 40 },
    { id: 'other', title: 'Other channels', items: all.filter((c) => isChan(c) && !c.is_archived && !c.is_member && c.kind !== 'private' && c.count > 0).sort(byName), collapsedByDefault: true },
    { id: 'archived', title: 'Archived channels', items: all.filter((c) => isChan(c) && c.is_archived && c.count > 0).sort(byName), collapsedByDefault: true },
  ];
}

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(lsGet('sdv.collapsed') || '{}');
  } catch {
    return {};
  }
}

export function isCollapsed(sec: Section, c: Record<string, boolean>) {
  return c[sec.id] ?? !!sec.collapsedByDefault;
}

/** Conversations in sidebar order (visible ones), for ⌥↑/⌥↓. */
export function sidebarOrder(s: Store): string[] {
  const c = loadCollapsed();
  return buildSections(s).flatMap((sec) => (isCollapsed(sec, c) ? [] : sec.items.slice(0, sec.limit && !c[sec.id + ':all'] ? sec.limit : undefined).map((x) => x.id)));
}

export function ChannelIcon({ c, size = 16 }: { c: Channel; size?: number }) {
  const { person, dmPartners } = useStore();
  if (c.kind === 'im') return <Avatar p={person(c.im_user)} size={size + 4} />;
  if (c.kind === 'mpim') return <span className="mpim-count">{Math.min(99, dmPartners(c).length)}</span>;
  if (c.is_archived) return <Archive size={size} />;
  if (c.kind === 'private') return <Lock size={size} />;
  return <Hash size={size} />;
}

export function Sidebar({ current, onOpen, onCommand }: { current?: string; onOpen: (id: string) => void; onCommand: (cmd: string) => void }) {
  const store = useStore();
  const sections = useMemo(() => buildSections(store), [store]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [menu, setMenu] = useState(false);
  const toggle = (k: string, v?: boolean) =>
    setCollapsed((c) => {
      const n = { ...c, [k]: v ?? !c[k] };
      lsSet('sdv.collapsed', JSON.stringify(n));
      return n;
    });
  return (
    <nav className="sidebar" aria-label="Conversations">
      <div className="sidebar-header">
        <button className="workspace-btn" onClick={() => setMenu((m) => !m)}>
          <span className="workspace-name">{store.boot.workspace.team || 'Workspace'}</span>
          <ChevronDown size={14} />
        </button>
        {menu && (
          <div className="menu-backdrop" onClick={() => setMenu(false)}>
            <div className="menu workspace-menu" onClick={(e) => e.stopPropagation()}>
              <div className="menu-title">
                {store.boot.workspace.team}
                <div className="menu-sub">Archive (read-only)</div>
              </div>
              {(
                [
                  ['prefs', <Settings size={15} key="i" />, 'Preferences', ''],
                  ['browse-channels', <Hash size={15} key="i" />, 'Browse channels', `${modKey}⇧L`],
                  ['people', <Users size={15} key="i" />, 'People', `${modKey}⇧E`],
                  ['browse-dms', <AtSign size={15} key="i" />, 'Direct messages', `${modKey}⇧K`],
                  ['unknown-users', <UserX size={15} key="i" />, 'Unknown users & aliases', ''],
                  ['shortcuts', <Keyboard size={15} key="i" />, 'Keyboard shortcuts', `${modKey}/`],
                ] as const
              ).map(([cmd, icon, label, key]) => (
                <button
                  key={cmd}
                  className="menu-item"
                  onClick={() => {
                    setMenu(false);
                    onCommand(cmd);
                  }}
                >
                  {icon}
                  <span className="menu-label">{label}</span>
                  {key && <kbd>{key}</kbd>}
                </button>
              ))}
              <div className="menu-sep" />
              <div className="menu-footnote" title={store.boot.archive_dir}>
                {store.boot.archive_dir}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="sidebar-scroll">
        <button className="sidebar-item sidebar-action" onClick={() => onCommand('search')}>
          <Search size={16} /> <span className="sidebar-label">Search</span>
        </button>
        <button className="sidebar-item sidebar-action" onClick={() => onCommand('browse-channels')}>
          <Hash size={16} /> <span className="sidebar-label">Browse channels</span>
        </button>
        <button className="sidebar-item sidebar-action" onClick={() => onCommand('people')}>
          <Users size={16} /> <span className="sidebar-label">People</span>
        </button>
        {sections.map((sec) => {
          const isC = isCollapsed(sec, collapsed);
          const showAll = collapsed[sec.id + ':all'];
          const items = sec.limit && !showAll ? sec.items.slice(0, sec.limit) : sec.items;
          // keep the current conversation visible even if collapsed
          const visible = isC ? sec.items.filter((c) => c.id === current) : items;
          if (sec.items.length === 0) return null;
          return (
            <div key={sec.id} className="sidebar-section">
              <button className="sidebar-section-title" onClick={() => toggle(sec.id, !isC)}>
                {isC ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                {sec.title}
                {isC && <span className="sidebar-section-count">{sec.items.length}</span>}
              </button>
              {visible.map((c) => (
                <SidebarItem key={c.id} c={c} active={c.id === current} onOpen={onOpen} />
              ))}
              {!isC && sec.limit && sec.items.length > sec.limit && (
                <button className="sidebar-item sidebar-more" onClick={() => toggle(sec.id + ':all')}>
                  {showAll ? 'Show fewer' : `Show all ${sec.items.length}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function SidebarItem({ c, active, onOpen }: { c: Channel; active: boolean; onOpen: (id: string) => void }) {
  const { channelLabel, person } = useStore();
  const label = channelLabel(c);
  const unknown = c.kind === 'im' && person(c.im_user).unknown;
  return (
    <button className={'sidebar-item' + (active ? ' active' : '') + (c.count === 0 ? ' empty' : '')} onClick={() => onOpen(c.id)} title={label} data-channel={c.id}>
      <span className="sidebar-icon">
        <ChannelIcon c={c} />
      </span>
      <span className={'sidebar-label' + (unknown ? ' unknown' : '')}>{label}</span>
    </button>
  );
}
