import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AliasEntry, Bootstrap, Channel, Message, User } from './api';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  showSuggestedAliases: boolean;
  externalImages: boolean;
  clock24: boolean;
}

const defaultPrefs: Prefs = { theme: 'system', showSuggestedAliases: false, externalImages: false, clock24: false };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem('sdv.prefs');
    if (raw) return { ...defaultPrefs, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return defaultPrefs;
}

export function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function lsSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

export interface Person {
  id: string; // the ID shown/clicked (may be an old account)
  name: string; // display name
  fullName?: string; // real name if different
  avatarId?: string; // user id whose avatar to use
  color: string;
  user?: User; // resolved current profile
  unknown: boolean;
  oldAccount: boolean; // resolved through an alias
  suggested: boolean; // alias is only a suggestion
  bot: boolean;
  deleted: boolean;
}

export interface Store {
  boot: Bootstrap;
  me: string;
  users: Map<string, User>;
  channels: Map<string, Channel>;
  avatars: Set<string>;
  aliases: Record<string, AliasEntry>;
  setAliases: (a: Record<string, AliasEntry>) => void;
  prefs: Prefs;
  setPrefs: (p: Partial<Prefs>) => void;
  person: (id: string | undefined) => Person;
  personFor: (m: Message) => Person;
  channelLabel: (c: Channel | undefined) => string;
  dmPartners: (c: Channel) => string[];
  handleFor: (id: string) => string;
  teamHost: string;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('store not ready');
  return s;
}

const palette = ['#e8912d', '#2bac76', '#1264a3', '#e01e5a', '#4a154b', '#36c5f0', '#9e3997', '#3c8a6e', '#d1495b', '#5b6abf', '#00838f', '#7c5295'];
export function colorFor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export function displayName(u: User): string {
  return u.display_name || u.real_name || u.name || u.id;
}

export function StoreProvider({ boot, children }: { boot: Bootstrap; children: ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const [aliases, setAliases] = useState<Record<string, AliasEntry>>(boot.aliases || {});
  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      lsSet('sdv.prefs', JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (prefs.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', prefs.theme);
  }, [prefs.theme]);

  const store = useMemo<Store>(() => {
    const users = new Map(boot.users.map((u) => [u.id, u]));
    const channels = new Map(boot.channels.map((c) => [c.id, c]));
    const avatars = new Set(boot.avatars);
    const me = boot.me;

    const person = (id: string | undefined): Person => {
      if (!id) return { id: '', name: 'Unknown', color: '#888', unknown: true, oldAccount: false, suggested: false, bot: false, deleted: false };
      const u = users.get(id);
      if (u) {
        return {
          id,
          name: displayName(u),
          fullName: u.real_name && u.real_name !== displayName(u) ? u.real_name : undefined,
          avatarId: avatars.has(id) ? id : undefined,
          color: u.color ? '#' + u.color : colorFor(id),
          user: u,
          unknown: false,
          oldAccount: false,
          suggested: false,
          bot: !!(u.is_bot || u.is_app),
          deleted: !!u.deleted,
        };
      }
      const a = aliases[id];
      if (a && (a.status === 'confirmed' || (a.status === 'suggested' && prefs.showSuggestedAliases))) {
        const target = a.maps_to ? users.get(a.maps_to) : undefined;
        const suggested = a.status === 'suggested';
        if (target) {
          return {
            id,
            name: displayName(target),
            fullName: target.real_name && target.real_name !== displayName(target) ? target.real_name : undefined,
            avatarId: avatars.has(target.id) ? target.id : undefined,
            color: target.color ? '#' + target.color : colorFor(target.id),
            user: target,
            unknown: false,
            oldAccount: true,
            suggested,
            bot: false,
            deleted: !!target.deleted,
          };
        }
        if (a.name) {
          return { id, name: a.name, color: colorFor(id), unknown: false, oldAccount: true, suggested, bot: false, deleted: true };
        }
      }
      if (id.startsWith('B')) return { id, name: 'App', color: colorFor(id), unknown: true, oldAccount: false, suggested: false, bot: true, deleted: false };
      return { id, name: `Unknown user ${id}`, color: colorFor(id), unknown: true, oldAccount: false, suggested: false, bot: false, deleted: false };
    };

    const personFor = (m: Message): Person => {
      if (m.user && (users.has(m.user) || !m.bot_id)) {
        const p = person(m.user);
        if (p.unknown && m.user_profile) {
          const n = m.user_profile.display_name || m.user_profile.real_name;
          if (n) return { ...p, name: n, unknown: false };
        }
        return p;
      }
      const name = m.bot_profile?.name || m.username || (m.user ? person(m.user).name : 'App');
      const id = m.bot_id || m.user || 'B0';
      return { id, name, color: colorFor(id), unknown: false, oldAccount: false, suggested: false, bot: true, deleted: false };
    };

    const dmPartners = (c: Channel): string[] => {
      if (c.kind === 'im') return [c.im_user || ''];
      let ids = (c.members || []).filter((x) => x !== me);
      if (ids.length === 0 && c.name.startsWith('mpdm-')) {
        // mpdm-alice--bob--carol-1: map handles to IDs
        const handles = c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--');
        const byHandle = new Map(boot.users.map((u) => [u.name, u.id]));
        ids = handles.map((h) => byHandle.get(h) || h).filter((x) => x !== me);
      }
      return ids;
    };

    const channelLabel = (c: Channel | undefined): string => {
      if (!c) return 'unknown';
      if (c.kind === 'im') {
        if (c.im_user === me) return `${person(me).name} (you)`;
        return person(c.im_user).name;
      }
      if (c.kind === 'mpim') {
        return dmPartners(c)
          .map((id) => (users.has(id) || aliases[id] ? person(id).name : id))
          .join(', ');
      }
      return c.name;
    };

    const handleFor = (id: string) => {
      const u = users.get(id);
      return u ? u.name : id;
    };

    let teamHost = '';
    try {
      teamHost = new URL(boot.workspace.url).host;
    } catch {
      /* ignore */
    }

    return { boot, me, users, channels, avatars, aliases, setAliases, prefs, setPrefs, person, personFor, channelLabel, dmPartners, handleFor, teamHost };
  }, [boot, aliases, prefs, setPrefs]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
