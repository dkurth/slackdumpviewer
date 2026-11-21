import { ArrowLeft, ArrowRight, Clock, Hash, Lock, Search, X } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Avatar } from './Avatar';
import { lsGet, lsSet, useStore } from './store';
import { fuzzyScore, modKey } from './util';

export interface SearchBoxHandle {
  focus: (prefill?: string) => void;
}

interface Suggestion {
  key: string;
  label: React.ReactNode;
  hint?: string;
  apply: () => void; // run on Enter/click
}

const MODIFIERS = [
  ['from:', 'Messages from a person'],
  ['in:', 'Messages in a channel or DM'],
  ['with:', 'DMs and threads with a person'],
  ['to:', 'Messages mentioning a person, or DMs to them'],
  ['before:', 'Before a date (2024-03-01, yesterday, march…)'],
  ['after:', 'After a date'],
  ['on:', 'On a date'],
  ['during:', 'During a month or year'],
  ['has:', 'link, file, pin, reaction, :emoji:'],
  ['is:', 'thread, dm, pinned, edited, bot'],
] as const;

export function recentSearches(): string[] {
  try {
    return JSON.parse(lsGet('sdv.recent') || '[]');
  } catch {
    return [];
  }
}
export function pushRecent(q: string) {
  const r = [q, ...recentSearches().filter((x) => x !== q)].slice(0, 10);
  lsSet('sdv.recent', JSON.stringify(r));
}

export const TopBar = forwardRef<SearchBoxHandle, { query: string; onSearch: (q: string) => void; onOpenChannel: (id: string) => void; onOpenProfile: (id: string) => void }>(
  function TopBar({ query, onSearch, onOpenChannel, onOpenProfile }, ref) {
    const store = useStore();
    const [value, setValue] = useState(query);
    const [open, setOpen] = useState(false);
    const [sel, setSel] = useState(0);
    const input = useRef<HTMLInputElement>(null);
    useEffect(() => setValue(query), [query]);
    useImperativeHandle(ref, () => ({
      focus: (prefill?: string) => {
        if (prefill !== undefined) setValue(prefill);
        setOpen(true);
        setSel(0);
        setTimeout(() => {
          input.current?.focus();
          const n = input.current?.value.length || 0;
          input.current?.setSelectionRange(n, n);
        }, 0);
      },
    }));

    const people = useMemo(() => [...store.users.values()], [store.users]);
    const convs = useMemo(() => [...store.channels.values()].filter((c) => c.kind !== 'im' && c.kind !== 'mpim'), [store.channels]);

    const tokenStart = value.lastIndexOf(' ') + 1;
    const token = value.slice(tokenStart);
    const replaceToken = (t: string) => {
      const v = value.slice(0, tokenStart) + t;
      setValue(v);
      setSel(0);
      input.current?.focus();
    };
    const run = (q: string) => {
      const t = q.trim();
      if (!t) return;
      pushRecent(t);
      setOpen(false);
      input.current?.blur();
      onSearch(t);
    };

    const suggestions: Suggestion[] = useMemo(() => {
      const out: Suggestion[] = [];
      const m = /^(-?)(from|in|with|to):(.*)$/i.exec(token);
      if (m) {
        const [, neg, key, rest] = m;
        const q = rest.replace(/^[@#]/, '');
        const exact =
          q.length > 0 &&
          (people.some((u) => u.name.toLowerCase() === q.toLowerCase() || u.id === q.toUpperCase()) || convs.some((c) => c.name.toLowerCase() === q.toLowerCase()) || q.toLowerCase() === 'me');
        if (exact && value.trim()) {
          // the modifier is complete: Enter searches
          out.push({ key: 'search', label: <><Search size={14} /> <b>{value.trim()}</b></>, hint: 'Search messages', apply: () => run(value) });
        }
        const wantChannels = key.toLowerCase() === 'in' && !rest.startsWith('@');
        if (wantChannels) {
          convs
            .map((c) => ({ c, s: q ? fuzzyScore(q, c.name) : 1 - (c.is_archived ? 1 : 0) + (c.is_member ? 1 : 0) }))
            .filter((x) => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 8)
            .forEach(({ c }) =>
              out.push({
                key: 'c' + c.id,
                label: (
                  <>
                    {c.kind === 'private' ? <Lock size={14} /> : <Hash size={14} />} {c.name}
                  </>
                ),
                hint: c.is_archived ? 'archived' : undefined,
                apply: () => replaceToken(`${neg}${key}:#${c.name} `),
              }),
            );
        }
        if (!wantChannels || !q || out.length < 3) {
          people
            .map((u) => ({ u, s: q ? Math.max(fuzzyScore(q, u.name), fuzzyScore(q, u.real_name || ''), fuzzyScore(q, u.display_name || '')) : 0 }))
            .filter((x) => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 8)
            .forEach(({ u }) =>
              out.push({
                key: 'u' + u.id,
                label: (
                  <>
                    <Avatar p={store.person(u.id)} size={20} /> {store.person(u.id).name} <span className="sugg-dim">{u.real_name !== store.person(u.id).name ? u.real_name : ''}</span>
                  </>
                ),
                hint: '@' + u.name,
                apply: () => replaceToken(`${neg}${key}:@${u.name} `),
              }),
            );
        }
        return out;
      }
      if (/^(has):/i.test(token)) {
        for (const v of ['link', 'file', 'pin', 'reaction', ':+1:']) {
          out.push({ key: 'h' + v, label: <>has:{v}</>, apply: () => replaceToken(`has:${v} `) });
        }
        return out;
      }
      if (/^(is):/i.test(token)) {
        for (const v of ['thread', 'dm', 'pinned', 'edited', 'bot']) out.push({ key: 'i' + v, label: <>is:{v}</>, apply: () => replaceToken(`is:${v} `) });
        return out;
      }
      if (/^(before|after|on|during):$/i.test(token)) {
        for (const v of ['today', 'yesterday', 'week', 'month', 'year', new Date().getFullYear() - 1 + '']) out.push({ key: 'd' + v, label: <>{token + v}</>, apply: () => replaceToken(token + v + ' ') });
        return out;
      }
      const v = value.trim();
      if (v) {
        out.push({
          key: 'search',
          label: (
            <>
              <Search size={14} /> <b>{v}</b>
            </>
          ),
          hint: 'Search messages',
          apply: () => run(v),
        });
        const low = token.toLowerCase();
        if (token && !token.includes(':')) {
          MODIFIERS.filter(([k]) => k.startsWith(low) && low.length >= 1)
            .slice(0, 3)
            .forEach(([k, d]) => out.push({ key: 'm' + k, label: <span className="sugg-mod">{k}</span>, hint: d, apply: () => replaceToken(k) }));
        }
        if (!v.includes(':')) {
          const all = [...store.channels.values()]
            .map((c) => ({ c, s: fuzzyScore(v, store.channelLabel(c)) }))
            .filter((x) => x.s > 150)
            .sort((a, b) => b.s - a.s)
            .slice(0, 4);
          all.forEach(({ c }) =>
            out.push({
              key: 'j' + c.id,
              label: (
                <>
                  {c.kind === 'private' ? <Lock size={14} /> : c.kind === 'public' ? <Hash size={14} /> : <span className="sugg-dm">@</span>} {store.channelLabel(c)}
                </>
              ),
              hint: 'Open',
              apply: () => {
                setOpen(false);
                onOpenChannel(c.id);
              },
            }),
          );
          people
            .map((u) => ({ u, s: Math.max(fuzzyScore(v, u.real_name || ''), fuzzyScore(v, u.display_name || ''), fuzzyScore(v, u.name)) }))
            .filter((x) => x.s > 150)
            .sort((a, b) => b.s - a.s)
            .slice(0, 3)
            .forEach(({ u }) =>
              out.push({
                key: 'p' + u.id,
                label: (
                  <>
                    <Avatar p={store.person(u.id)} size={20} /> {store.person(u.id).name}
                  </>
                ),
                hint: 'Profile',
                apply: () => {
                  setOpen(false);
                  onOpenProfile(u.id);
                },
              }),
            );
        }
      } else {
        recentSearches().forEach((r) =>
          out.push({
            key: 'r' + r,
            label: (
              <>
                <Clock size={14} /> {r}
              </>
            ),
            apply: () => {
              setValue(r);
              run(r);
            },
          }),
        );
        MODIFIERS.forEach(([k, d]) => out.push({ key: 'm' + k, label: <span className="sugg-mod">{k}</span>, hint: d, apply: () => replaceToken(k) }));
      }
      return out;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, token, store, people, convs]);

    const onKey = (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel((s) => Math.min(suggestions.length - 1, s + 1));
        setOpen(true);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel((s) => Math.max(0, s - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const s = open ? suggestions[sel] : undefined;
        if (s) s.apply();
        else run(value);
      } else if (e.key === 'Tab' && open && suggestions[sel] && token.includes(':')) {
        e.preventDefault();
        suggestions[sel].apply();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        input.current?.blur();
      }
    };

    return (
      <header className="topbar">
        <div className="topbar-nav">
          <button className="icon-btn light" onClick={() => history.back()} title={`Back (${modKey}[)`}>
            <ArrowLeft size={18} />
          </button>
          <button className="icon-btn light" onClick={() => history.forward()} title={`Forward (${modKey}])`}>
            <ArrowRight size={18} />
          </button>
        </div>
        <div className={'searchbox' + (open ? ' open' : '')}>
          <Search size={15} className="searchbox-icon" />
          <input
            ref={input}
            value={value}
            placeholder={`Search ${store.boot.workspace.team || 'archive'}`}
            onChange={(e) => {
              setValue(e.target.value);
              setOpen(true);
              setSel(0);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKey}
            spellCheck={false}
            aria-label="Search"
          />
          {value && (
            <button className="icon-btn searchbox-clear" onMouseDown={(e) => (e.preventDefault(), setValue(''), input.current?.focus())} title="Clear">
              <X size={14} />
            </button>
          )}
          {open && suggestions.length > 0 && (
            <div className="search-suggest" role="listbox">
              {suggestions.map((s, i) => (
                <div
                  key={s.key}
                  role="option"
                  aria-selected={i === sel}
                  className={'sugg' + (i === sel ? ' sel' : '')}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    s.apply();
                  }}
                  onMouseEnter={() => setSel(i)}
                >
                  <span className="sugg-label">{s.label}</span>
                  {s.hint && <span className="sugg-hint">{s.hint}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="topbar-right" />
      </header>
    );
  },
);
