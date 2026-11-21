import { Check, ChevronDown, ChevronRight, MessageSquare, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type AliasEntry, type Message as Msg, type UnknownUser } from './api';
import { Avatar } from './Avatar';
import { Message } from './Message';
import { useStore } from './store';
import { useUI } from './ui';
import { formatShortDate, fuzzyScore } from './util';

function Samples({ id }: { id: string }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  useEffect(() => {
    api.search(`from:${id}`, 'newest', 0).then((r) => setMsgs(r.messages.slice(0, 6)));
  }, [id]);
  if (!msgs) return <div className="empty-state small">Loading…</div>;
  return (
    <div className="uu-samples">
      {msgs.map((m) => (
        <Message key={m._ch + m.ts} m={m} showChannel />
      ))}
    </div>
  );
}

function PersonPicker({ onPick, onCancel }: { onPick: (id: string) => void; onCancel: () => void }) {
  const store = useStore();
  const [q, setQ] = useState('');
  const list = useMemo(
    () =>
      [...store.users.values()]
        .map((u) => ({ u, s: q ? Math.max(fuzzyScore(q, u.real_name || ''), fuzzyScore(q, u.display_name || ''), fuzzyScore(q, u.name)) : 0 }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 12),
    [q, store],
  );
  return (
    <div className="uu-picker">
      <input autoFocus placeholder="Find the current account…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      {list.map(({ u }) => (
        <button key={u.id} className="menu-item" onClick={() => onPick(u.id)}>
          <Avatar p={store.person(u.id)} size={20} /> {store.person(u.id).name} <span className="sugg-dim">@{u.name}{u.deleted ? ' · deactivated' : ''}</span>
        </button>
      ))}
      <button className="btn btn-small" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

function Row({ u, onSaved }: { u: UnknownUser; onSaved: (id: string, e: AliasEntry) => void }) {
  const store = useStore();
  const ui = useUI();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(u.alias?.name || '');
  const a = u.alias;
  const save = (e: Partial<AliasEntry>) =>
    api.setAlias(u.id, { status: e.status || 'confirmed', maps_to: e.maps_to ?? a?.maps_to ?? '', name: e.name ?? a?.name ?? '' }).then((r) => onSaved(u.id, r.alias));
  const target = a?.maps_to ? store.person(a.maps_to) : null;
  return (
    <div className={'uu-row status-' + (a?.status || 'none')}>
      <div className="uu-main">
        <button className="icon-btn" onClick={() => setOpen((o) => !o)} title="Show messages">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="uu-id">
          <span className="mono">{u.id}</span>
          <span className="uu-stats">
            {u.messages.toLocaleString()} messages · {u.channels} conversations · {formatShortDate(u.first_ts)} – {formatShortDate(u.last_ts)}
          </span>
        </div>
        <div className="uu-alias">
          {a && (a.maps_to || a.name) ? (
            <>
              <span className={'uu-status ' + a.status}>{a.status}</span>
              {target ? (
                <span className="uu-target">
                  <Avatar p={target} size={20} /> {target.name}
                </span>
              ) : (
                <span className="uu-target">{a.name}</span>
              )}
              {a.confidence ? <span className="uu-conf">{Math.round(a.confidence * 100)}%</span> : null}
            </>
          ) : (
            <span className="muted">No suggestion</span>
          )}
        </div>
        <div className="uu-actions">
          {a && a.status !== 'confirmed' && (a.maps_to || a.name) && (
            <button className="btn btn-small btn-primary" onClick={() => save({ status: 'confirmed' })} title="Confirm">
              <Check size={14} /> Confirm
            </button>
          )}
          {a && a.status !== 'rejected' && (a.maps_to || a.name) && (
            <button className="btn btn-small" onClick={() => save({ status: 'rejected' })} title="Reject">
              <X size={14} /> Reject
            </button>
          )}
          <button className="btn btn-small" onClick={() => setPicking(true)}>
            Map to person…
          </button>
          <button className="btn btn-small" onClick={() => setNaming(true)}>
            Name…
          </button>
        </div>
      </div>
      {a?.evidence && a.evidence.length > 0 && (
        <ul className="uu-evidence">
          {a.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {picking && (
        <PersonPicker
          onCancel={() => setPicking(false)}
          onPick={(id) => {
            setPicking(false);
            save({ status: 'confirmed', maps_to: id, name: '' });
          }}
        />
      )}
      {naming && (
        <form
          className="uu-name"
          onSubmit={(e) => {
            e.preventDefault();
            setNaming(false);
            save({ status: 'confirmed', name, maps_to: '' });
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" />
          <button className="btn btn-small btn-primary" type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button className="btn btn-small" type="button" onClick={() => setNaming(false)}>
            Cancel
          </button>
        </form>
      )}
      {open && (
        <div className="uu-detail">
          <div className="uu-links">
            {u.dm && (
              <button className="btn btn-small" onClick={() => ui.openChannel(u.dm!)}>
                <MessageSquare size={14} /> Your DM with them
              </button>
            )}
            <button className="btn btn-small" onClick={() => ui.search(`from:${u.id}`)}>
              <Search size={14} /> All their messages
            </button>
            <button className="btn btn-small" onClick={() => ui.search(`<@${u.id}>`)}>
              <Search size={14} /> Mentions
            </button>
          </div>
          <Samples id={u.id} />
        </div>
      )}
    </div>
  );
}

export function UnknownUsersPage() {
  const store = useStore();
  const [list, setList] = useState<UnknownUser[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'suggested' | 'confirmed' | 'none'>('all');
  useEffect(() => {
    api.unknownUsers().then((r) => setList(r.users));
  }, []);
  const onSaved = (id: string, e: AliasEntry) => {
    setList((l) => l?.map((u) => (u.id === id ? { ...u, alias: e } : u)) || null);
    store.setAliases({ ...store.aliases, [id]: e });
  };
  const shown = (list || []).filter((u) =>
    filter === 'all' ? true : filter === 'none' ? !u.alias || (!u.alias.maps_to && !u.alias.name) : u.alias?.status === filter,
  );
  const counts = {
    suggested: (list || []).filter((u) => u.alias?.status === 'suggested').length,
    confirmed: (list || []).filter((u) => u.alias?.status === 'confirmed').length,
  };
  return (
    <div className="unknown-page">
      <div className="search-head">
        <h1>Unknown users &amp; aliases</h1>
        <p className="muted">
          These user IDs appear in messages but have no profile in the archive — mostly old accounts from before the workspace merge. Map each one to a
          current person (or give it a name). Decisions are saved to <span className="mono">.slackdumpviewer/aliases.json</span>, which you can also edit by hand.
        </p>
        <div className="search-tabs">
          {(
            [
              ['all', `All ${list?.length ?? ''}`],
              ['suggested', `Suggested ${counts.suggested}`],
              ['confirmed', `Confirmed ${counts.confirmed}`],
              ['none', 'No suggestion'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={'search-tab' + (filter === k ? ' active' : '')} onClick={() => setFilter(k)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="search-body">
        {!list && <div className="empty-state">Loading…</div>}
        {shown.map((u) => (
          <Row key={u.id} u={u} onSaved={onSaved} />
        ))}
      </div>
    </div>
  );
}
