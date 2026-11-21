import { ChevronDown, Hash, Lock, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, thumbURL, type FileHit, type Message as Msg } from './api';
import { Avatar } from './Avatar';
import { Message } from './Message';
import { navigate } from './router';
import { useStore } from './store';
import { HighlightCtx, useUI } from './ui';
import { formatShortDate, formatSize, fuzzyScore } from './util';

// ---- query helpers (filters live in the query text, like Slack) ----

function tokens(q: string): string[] {
  return q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

export function setFilter(q: string, key: string, value: string | null, multi = false): string {
  const re = new RegExp(`^-?${key}:`, 'i');
  let t = tokens(q);
  if (!multi || value === null) t = t.filter((x) => !re.test(x));
  if (value !== null) {
    const tok = `${key}:${/\s/.test(value) ? `"${value}"` : value}`;
    if (!t.some((x) => x.toLowerCase() === tok.toLowerCase())) t.push(tok);
  }
  return t.join(' ');
}

export function getFilters(q: string, key: string): string[] {
  const re = new RegExp(`^${key}:(.+)$`, 'i');
  return tokens(q)
    .map((x) => re.exec(x)?.[1])
    .filter((x): x is string => !!x)
    .map((x) => x.replace(/^"|"$/g, ''));
}

export function plainTerms(q: string): string {
  return tokens(q)
    .filter((x) => !/^-?[a-z]+:/i.test(x))
    .join(' ')
    .replace(/"/g, '');
}

function Popover({ label, active, children, onClear }: { label: ReactNode; active?: boolean; children: (close: () => void) => ReactNode; onClear?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="filter">
      <button className={'filter-btn' + (active ? ' active' : '')} onClick={() => setOpen((o) => !o)}>
        {label}
        {active && onClear ? (
          <X
            size={13}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          />
        ) : (
          <ChevronDown size={13} />
        )}
      </button>
      {open && (
        <>
          <div className="menu-backdrop transparent" onClick={() => setOpen(false)} />
          <div className="menu filter-menu">{children(() => setOpen(false))}</div>
        </>
      )}
    </div>
  );
}

function PickList<T>({ items, render, onPick, placeholder, score }: { items: T[]; render: (t: T) => ReactNode; onPick: (t: T) => void; placeholder: string; score: (t: T, q: string) => number }) {
  const [q, setQ] = useState('');
  const shown = useMemo(
    () =>
      (q ? items.map((t) => ({ t, s: score(t, q) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.t) : items).slice(0, 50),
    [items, q, score],
  );
  return (
    <div className="picklist">
      <input autoFocus placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && shown[0] && onPick(shown[0])} />
      <div className="picklist-items">
        {shown.map((t, i) => (
          <button key={i} className="menu-item" onClick={() => onPick(t)}>
            {render(t)}
          </button>
        ))}
      </div>
    </div>
  );
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function Filters({ q, set }: { q: string; set: (q: string) => void }) {
  const store = useStore();
  const users = useMemo(() => [...store.users.values()].sort((a, b) => store.person(a.id).name.localeCompare(store.person(b.id).name)), [store]);
  const chans = useMemo(() => [...store.channels.values()].filter((c) => c.kind === 'public' || c.kind === 'private').sort((a, b) => a.name.localeCompare(b.name)), [store]);
  const from = getFilters(q, 'from');
  const inn = getFilters(q, 'in');
  const has = getFilters(q, 'has');
  const dateKeys = ['before', 'after', 'on', 'during'];
  const dates = dateKeys.flatMap((k) => getFilters(q, k).map((v) => `${k}:${v}`));
  const clearDates = (s: string) => dateKeys.reduce((acc, k) => setFilter(acc, k, null), s);
  const isThread = getFilters(q, 'is').includes('thread');
  const [after, setAfter] = useState('');
  const [before, setBefore] = useState('');
  return (
    <div className="filters">
      <Popover label={from.length ? `From: ${from.join(', ')}` : 'From'} active={from.length > 0} onClear={() => set(setFilter(q, 'from', null))}>
        {(close) => (
          <PickList
            items={users}
            placeholder="e.g. Pat"
            score={(u, s) => Math.max(fuzzyScore(s, u.name), fuzzyScore(s, u.real_name || ''), fuzzyScore(s, u.display_name || ''))}
            render={(u) => (
              <>
                <Avatar p={store.person(u.id)} size={20} /> {store.person(u.id).name} <span className="sugg-dim">@{u.name}</span>
              </>
            )}
            onPick={(u) => {
              set(setFilter(q, 'from', '@' + u.name, true));
              close();
            }}
          />
        )}
      </Popover>
      <Popover label={inn.length ? `In: ${inn.join(', ')}` : 'In'} active={inn.length > 0} onClear={() => set(setFilter(q, 'in', null))}>
        {(close) => (
          <PickList
            items={chans}
            placeholder="e.g. #general"
            score={(c, s) => fuzzyScore(s, c.name)}
            render={(c) => (
              <>
                {c.kind === 'private' ? <Lock size={14} /> : <Hash size={14} />} {c.name} {c.is_archived && <span className="sugg-dim">archived</span>}
              </>
            )}
            onPick={(c) => {
              set(setFilter(q, 'in', '#' + c.name, true));
              close();
            }}
          />
        )}
      </Popover>
      <Popover label={dates.length ? dates.join(' ') : 'Date'} active={dates.length > 0} onClear={() => set(clearDates(q))}>
        {(close) => (
          <div className="date-filter">
            {(
              [
                ['Today', 'on:today'],
                ['Yesterday', 'on:yesterday'],
                ['Last 7 days', `after:${daysAgo(8)}`],
                ['Last 30 days', `after:${daysAgo(31)}`],
                ['Last 12 months', `after:${daysAgo(366)}`],
              ] as const
            ).map(([l, f]) => (
              <button
                key={l}
                className="menu-item"
                onClick={() => {
                  const [k, v] = f.split(':');
                  set(setFilter(clearDates(q), k, v));
                  close();
                }}
              >
                {l}
              </button>
            ))}
            <div className="menu-sep" />
            <div className="date-range">
              <label>
                After <input type="date" value={after} onChange={(e) => setAfter(e.target.value)} />
              </label>
              <label>
                Before <input type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
              </label>
              <button
                className="btn btn-primary btn-small"
                disabled={!after && !before}
                onClick={() => {
                  let n = clearDates(q);
                  if (after) n = setFilter(n, 'after', after);
                  if (before) n = setFilter(n, 'before', before);
                  set(n);
                  close();
                }}
              >
                Apply
              </button>
            </div>
          </div>
        )}
      </Popover>
      <Popover label={has.length ? `Has: ${has.join(', ')}` : 'Has'} active={has.length > 0} onClear={() => set(setFilter(q, 'has', null))}>
        {(close) => (
          <div>
            {['link', 'file', 'pin', 'reaction'].map((v) => (
              <button
                key={v}
                className="menu-item"
                onClick={() => {
                  set(has.includes(v) ? tokens(q).filter((t) => t !== `has:${v}`).join(' ') : setFilter(q, 'has', v, true));
                  close();
                }}
              >
                <input type="checkbox" readOnly checked={has.includes(v)} /> {v}
              </button>
            ))}
          </div>
        )}
      </Popover>
      <button className={'filter-btn' + (isThread ? ' active' : '')} onClick={() => set(isThread ? tokens(q).filter((t) => t.toLowerCase() !== 'is:thread').join(' ') : setFilter(q, 'is', 'thread', true))}>
        Only threads
      </button>
    </div>
  );
}

// ---- results ----

function MessageResults({ q, sort, onCount }: { q: string; sort: string; onCount: (n: number) => void }) {
  const ui = useUI();
  const [items, setItems] = useState<Msg[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [terms, setTerms] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setItems([]);
    setTotal(null);
    setError(null);
    setLoading(true);
    api
      .search(q, sort, 0, ac.signal)
      .then((r) => {
        setItems(r.messages);
        setTotal(r.total);
        setTerms(r.terms || []);
        setWarnings(r.warnings || []);
        onCount(r.total);
      })
      .catch((e) => e.name !== 'AbortError' && setError(String(e.message || e)))
      .finally(() => setLoading(false));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sort]);

  const more = () => {
    if (loading || total === null || items.length >= total) return;
    setLoading(true);
    api
      .search(q, sort, items.length)
      .then((r) => setItems((cur) => [...cur, ...r.messages]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && more());
    io.observe(el);
    return () => io.disconnect();
  });

  if (error) return <div className="empty-state">Search failed: {error}</div>;
  return (
    <HighlightCtx.Provider value={terms}>
      {warnings.map((w) => (
        <div key={w} className="search-warning">
          {w}
        </div>
      ))}
      {total === 0 && !loading && (
        <div className="empty-state">
          <h3>No results</h3>
          <p>Try fewer words, check spelling, or remove a filter.</p>
        </div>
      )}
      <div className="search-results">
        {items.map((m) => (
          <div
            key={m._ch + m.ts}
            className="search-result"
            onClick={() => (m._parent ? ui.openThread(m._ch, m._parent, m.ts) : ui.openChannel(m._ch, m.ts))}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && (m._parent ? ui.openThread(m._ch, m._parent, m.ts) : ui.openChannel(m._ch, m.ts))}
          >
            <Message m={m} showChannel />
          </div>
        ))}
      </div>
      <div ref={sentinel} className="list-loading">
        {loading ? 'Searching…' : total !== null && items.length < total ? '' : ''}
      </div>
    </HighlightCtx.Provider>
  );
}

function FileResults({ q, sort, onCount }: { q: string; sort: string; onCount: (n: number) => void }) {
  const store = useStore();
  const ui = useUI();
  const [files, setFiles] = useState<FileHit[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setFiles([]);
    api
      .searchFiles(q, sort === 'relevance' ? 'relevance' : sort, 0, ac.signal)
      .then((r) => {
        setFiles(r.files || []);
        setTotal(r.total);
        onCount(r.total);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, sort]);
  const more = () => {
    setLoading(true);
    api
      .searchFiles(q, sort, files.length)
      .then((r) => setFiles((c) => [...c, ...(r.files || [])]))
      .finally(() => setLoading(false));
  };
  return <FileTable files={files} total={total} loading={loading} onMore={more} store={store} ui={ui} />;
}

export function FileTable({ files, total, loading, onMore, store, ui }: { files: FileHit[]; total: number | null; loading: boolean; onMore: () => void; store: ReturnType<typeof useStore>; ui: ReturnType<typeof useUI> }) {
  if (total === 0 && !loading) return <div className="empty-state">No files</div>;
  return (
    <div className="file-results">
      {files.map((f) => {
        const ch = store.channels.get(f.channel);
        const img = f.local && /^image\/(png|jpe?g|gif|webp)/.test(f.mimetype || '');
        return (
          <button key={f.id + f.ts} className="file-row" onClick={() => (f.thread_ts ? ui.openThread(f.channel, f.thread_ts, f.ts) : ui.openChannel(f.channel, f.ts))}>
            <span className="file-row-thumb">{img ? <img src={thumbURL(f.id, 128)} alt="" loading="lazy" /> : <span className="file-row-ext">{(f.filetype || '?').slice(0, 4)}</span>}</span>
            <span className="file-row-main">
              <span className="file-row-name">{f.title || f.name}</span>
              <span className="file-row-sub">
                {f.user ? store.person(f.user).name + ' · ' : ''}
                {ch ? store.channelLabel(ch) + ' · ' : ''}
                {formatShortDate(f.ts)}
                {f.size ? ' · ' + formatSize(f.size) : ''}
                {!f.local && f.mode !== 'external' ? ' · not downloaded' : ''}
              </span>
            </span>
          </button>
        );
      })}
      {total !== null && files.length < total && (
        <button className="btn load-more" onClick={onMore} disabled={loading}>
          {loading ? 'Loading…' : `Load more (${total - files.length})`}
        </button>
      )}
    </div>
  );
}

export function SearchPage({ q, tab, sort }: { q: string; tab: string; sort: string }) {
  const store = useStore();
  const ui = useUI();
  const [counts, setCounts] = useState<{ messages?: number; files?: number }>({});
  useEffect(() => setCounts({}), [q]);
  const go = (p: { q?: string; tab?: string; sort?: string }) => navigate({ kind: 'search', q: p.q ?? q, tab: p.tab ?? tab, sort: p.sort ?? sort });
  const plain = plainTerms(q);
  const chanMatches = useMemo(
    () =>
      plain
        ? [...store.channels.values()]
            .filter((c) => c.kind === 'public' || c.kind === 'private')
            .map((c) => ({ c, s: Math.max(fuzzyScore(plain, c.name), (c.purpose || '').toLowerCase().includes(plain.toLowerCase()) ? 100 : -1) }))
            .filter((x) => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.c)
        : [],
    [plain, store],
  );
  const peopleMatches = useMemo(
    () =>
      plain
        ? [...store.users.values()]
            .map((u) => ({ u, s: Math.max(fuzzyScore(plain, u.real_name || ''), fuzzyScore(plain, u.display_name || ''), fuzzyScore(plain, u.name), fuzzyScore(plain, u.title || '') - 100) }))
            .filter((x) => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.u)
        : [],
    [plain, store],
  );
  const tabs: [string, string, number | undefined][] = [
    ['messages', 'Messages', counts.messages],
    ['files', 'Files', counts.files],
    ['channels', 'Channels', plain ? chanMatches.length : undefined],
    ['people', 'People', plain ? peopleMatches.length : undefined],
  ];
  return (
    <div className="search-page">
      <div className="search-head">
        <h1>
          Search results{plain ? <> for “{plain}”</> : null}
        </h1>
        <div className="search-tabs" role="tablist">
          {tabs.map(([id, label, n]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={'search-tab' + (tab === id ? ' active' : '')} onClick={() => go({ tab: id })}>
              {label}
              {n !== undefined && <span className="tab-count">{n.toLocaleString()}</span>}
            </button>
          ))}
        </div>
        {(tab === 'messages' || tab === 'files') && (
          <div className="search-tools">
            <Filters q={q} set={(nq) => go({ q: nq })} />
            <select className="sort-select" value={sort} onChange={(e) => go({ sort: e.target.value })} aria-label="Sort">
              <option value="relevance">Most relevant</option>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </div>
        )}
      </div>
      <div className="search-body">
        {tab === 'messages' && <MessageResults q={q} sort={sort} onCount={(n) => setCounts((c) => ({ ...c, messages: n }))} />}
        {tab === 'files' && <FileResults q={q} sort={sort} onCount={(n) => setCounts((c) => ({ ...c, files: n }))} />}
        {tab === 'channels' && (
          <div className="browse-list">
            {chanMatches.map((c) => (
              <button key={c.id} className="browse-row" onClick={() => ui.openChannel(c.id)}>
                <span className="browse-name">
                  {c.kind === 'private' ? <Lock size={14} /> : <Hash size={14} />} {c.name} {c.is_archived && <span className="badge">archived</span>}
                </span>
                <span className="browse-sub">
                  {c.count.toLocaleString()} messages{c.purpose ? ' · ' + c.purpose : ''}
                </span>
              </button>
            ))}
            {chanMatches.length === 0 && <div className="empty-state">No channels match.</div>}
          </div>
        )}
        {tab === 'people' && (
          <div className="people-grid">
            {peopleMatches.map((u) => (
              <button key={u.id} className="person-card" onClick={(e) => ui.openProfile(u.id, e.currentTarget)}>
                <Avatar p={store.person(u.id)} size={96} />
                <span className="person-name">{store.person(u.id).name}</span>
                <span className="person-title">{u.title || u.real_name}</span>
              </button>
            ))}
            {peopleMatches.length === 0 && <div className="empty-state">No people match.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
