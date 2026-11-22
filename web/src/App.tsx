import { Hash, Info, Lock, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type Bootstrap, type Channel, type Status } from './api';
import { Avatar } from './Avatar';
import { Lightbox } from './Files';
import { BrowseChannels, BrowseDMs, ChannelDetails, People, Prefs, ProfilePane, pushRecentConv, QuickSwitcher, ShortcutsHelp } from './Modals';
import { MessageList, type Anchor, type MessageListHandle } from './MessageList';
import { Mrkdwn } from './mrkdwn';
import { navigate, useRoute, type Route } from './router';
import { SearchPage } from './SearchPage';
import { Sidebar, sidebarOrder } from './Sidebar';
import { lsGet, lsSet, StoreProvider, useStore } from './store';
import { ThreadPane } from './ThreadPane';
import { TopBar, type SearchBoxHandle } from './TopBar';
import { UICtx, type UI } from './ui';
import { UnknownUsersPage } from './UnknownUsers';
import { isMod } from './util';

// ---------- loading gate ----------

export function Root() {
  const [status, setStatus] = useState<Status | null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.status();
        if (stop) return;
        setStatus(s);
        if (s.ready) {
          setBoot(await api.bootstrap());
          return;
        }
        if (s.error) return;
      } catch (e) {
        setErr(String(e));
      }
      if (!stop) setTimeout(tick, 400);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);
  if (boot) {
    return (
      <StoreProvider boot={boot}>
        <App />
      </StoreProvider>
    );
  }
  const p = status?.progress;
  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
  return (
    <div className="splash">
      <div className="splash-card">
        <div className="splash-logo" />
        {status?.error ? (
          <>
            <h2>Indexing failed</h2>
            <p className="mono">{status.error}</p>
          </>
        ) : err ? (
          <>
            <h2>Can't reach the viewer</h2>
            <p>{err}</p>
          </>
        ) : (
          <>
            <h2>{p ? 'Preparing your archive' : 'Loading…'}</h2>
            {p && (
              <>
                <p>
                  {p.phase}
                  {p.total ? ` — ${p.done.toLocaleString()} of ${p.total.toLocaleString()} messages` : ''}
                </p>
                <div className="progress">
                  <div style={{ width: pct + '%' }} />
                </div>
                <p className="muted small">This happens once; later launches open instantly.</p>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- channel view ----------

function ChannelHeader({ c, onDetails }: { c: Channel; onDetails: () => void }) {
  const { channelLabel, person, dmPartners } = useStore();
  const dm = c.kind === 'im' || c.kind === 'mpim';
  const n = c.members?.length || c.num_members || 0;
  return (
    <div className="channel-header">
      <button className="channel-title" onClick={onDetails} title="Conversation details">
        {c.kind === 'im' ? <Avatar p={person(c.im_user)} size={22} /> : c.kind === 'mpim' ? <Users size={18} /> : c.kind === 'private' ? <Lock size={18} /> : <Hash size={18} />}
        <span className="channel-name">{channelLabel(c)}</span>
        {c.is_archived && <span className="badge">archived</span>}
      </button>
      {c.topic && !dm && (
        <div className="channel-topic" title={c.topic}>
          <Mrkdwn text={c.topic} className="inline" />
        </div>
      )}
      <div className="channel-header-right">
        {!dm || c.kind === 'mpim' ? (
          <button className="member-btn" onClick={onDetails} title="Members">
            <span className="member-faces">
              {(c.kind === 'mpim' ? dmPartners(c) : c.members || []).slice(0, 3).map((m) => (
                <Avatar key={m} p={person(m)} size={20} />
              ))}
            </span>
            {n}
          </button>
        ) : null}
        <button className="icon-btn" onClick={onDetails} title="Details">
          <Info size={18} />
        </button>
      </div>
    </div>
  );
}

function ChannelView({ route, listRef, onDetails }: { route: Extract<Route, { kind: 'channel' }>; listRef: React.RefObject<MessageListHandle | null>; onDetails: () => void }) {
  const { channels } = useStore();
  const c = channels.get(route.ch);
  // The list anchor follows explicit message links (route.ts) only; opening
  // or closing a thread must not move or reload the conversation.
  const [initial, setInitial] = useState<Anchor>(() => {
    if (route.ts) return { kind: 'ts', ts: route.ts, highlight: true };
    if (route.thread) return { kind: 'ts', ts: route.thread, highlight: false };
    return { kind: 'latest' };
  });
  const lastTs = useRef(route.ts);
  useEffect(() => {
    if (route.ts && route.ts !== lastTs.current) setInitial({ kind: 'ts', ts: route.ts, highlight: true });
    lastTs.current = route.ts;
  }, [route.ts]);

  // A permalink to a thread reply opens the thread.
  useEffect(() => {
    if (!route.ts) return;
    api.lookup(route.ch, route.ts).then((r) => {
      if (r.found && !r.top && r.thread_ts) navigate({ kind: 'channel', ch: route.ch, thread: r.thread_ts, reply: route.ts }, true);
    });
  }, [route.ch, route.ts]);

  if (!c) return <div className="empty-state">This conversation isn't in the archive ({route.ch}).</div>;
  return (
    <div className="channel-view">
      <ChannelHeader c={c} onDetails={onDetails} />
      <MessageList ref={listRef} channel={c} anchor={initial} />
    </div>
  );
}

// ---------- app ----------

type ModalKind = null | 'switcher' | 'shortcuts' | 'prefs' | 'browse-channels' | 'browse-dms' | 'people' | 'details';

function App() {
  const store = useStore();
  const route = useRoute();
  const [modal, setModal] = useState<ModalKind>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [pane, setPane] = useState<'thread' | 'profile' | null>(null);
  const [paneHidden, setPaneHidden] = useState(false);
  const [sidebar, setSidebar] = useState(lsGet('sdv.sidebar') !== 'hidden');
  const [lightbox, setLightbox] = useState<{ files: { id: string; name?: string }[]; index: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const search = useRef<SearchBoxHandle>(null);
  const list = useRef<MessageListHandle>(null);

  const currentCh = route.kind === 'channel' ? route.ch : undefined;
  const threadKey = route.kind === 'channel' && route.thread ? `${route.ch}:${route.thread}` : null;

  useEffect(() => {
    if (threadKey) {
      setPane('thread');
      setPaneHidden(false);
    } else if (pane === 'thread') setPane(profile ? 'profile' : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadKey]);

  // home → last or #general
  useEffect(() => {
    if (route.kind !== 'home') return;
    const last = lsGet('sdv.last');
    const general = store.boot.channels.find((c) => c.is_general);
    const firstWith = store.boot.channels.find((c) => c.count > 0);
    const target = (last && store.channels.has(last) && last) || general?.id || firstWith?.id;
    if (target) navigate({ kind: 'channel', ch: target }, true);
  }, [route, store]);

  useEffect(() => {
    if (currentCh && store.channels.has(currentCh)) {
      lsSet('sdv.last', currentCh);
      pushRecentConv(currentCh);
    }
  }, [currentCh, store.channels]);

  // window title like Slack ("#general - Team"), tagged so it isn't mistaken for the real Slack
  useEffect(() => {
    const team = store.boot.workspace.team;
    let t = team;
    if (route.kind === 'channel') {
      const c = store.channels.get(route.ch);
      if (c) t = `${c.kind === 'public' || c.kind === 'private' ? '#' : ''}${store.channelLabel(c)} - ${team}`;
    } else if (route.kind === 'search') t = `Search: ${route.q} - ${team}`;
    document.title = `${t} — SlackDumpViewer`;
  }, [route, store]);

  const ui = useMemo<UI>(
    () => ({
      openProfile: (id) => {
        setProfile(id);
        setPane('profile');
        setPaneHidden(false);
      },
      openChannel: (ch, ts) => navigate({ kind: 'channel', ch, ts }),
      openThread: (ch, parent, reply) => {
        setPane('thread');
        navigate({ kind: 'channel', ch, thread: parent, reply });
      },
      openLightbox: (files, index) => setLightbox({ files, index }),
      search: (q) => navigate({ kind: 'search', q, tab: 'messages', sort: 'relevance' }),
      toast: (m) => {
        setToast(m);
        setTimeout(() => setToast((t) => (t === m ? null : t)), 1800);
      },
    }),
    [],
  );

  const closePane = useCallback(() => {
    if (pane === 'thread' && route.kind === 'channel') {
      navigate({ kind: 'channel', ch: route.ch });
      setPane(profile ? null : null);
    } else setPane(null);
  }, [pane, route, profile]);

  const cycleFocus = useCallback(
    (back: boolean) => {
      const regions = [
        document.querySelector<HTMLElement>('.sidebar .sidebar-item.active') || document.querySelector<HTMLElement>('.sidebar .sidebar-item'),
        document.querySelector<HTMLElement>('.message-list') || document.querySelector<HTMLElement>('.search-body'),
        document.querySelector<HTMLElement>('.side-pane .pane-body'),
      ].filter((x): x is HTMLElement => !!x);
      const active = document.activeElement;
      let i = regions.findIndex((r) => r === active || r.contains(active) || (r.closest('.sidebar') && active?.closest('.sidebar')));
      i = i < 0 ? 0 : (i + (back ? -1 : 1) + regions.length) % regions.length;
      regions[i]?.focus();
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = isMod(e);
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && (k === 'k' || k === 't')) {
        e.preventDefault();
        setModal('switcher');
      } else if (mod && !e.shiftKey && k === 'g') {
        e.preventDefault();
        search.current?.focus();
      } else if (mod && !e.shiftKey && k === 'f') {
        e.preventDefault();
        const c = currentCh ? store.channels.get(currentCh) : undefined;
        const scope = c ? (c.kind === 'im' ? `in:@${store.handleFor(c.im_user || '')} ` : c.kind === 'mpim' ? '' : `in:#${c.name} `) : '';
        search.current?.focus(scope);
      } else if (mod && !e.shiftKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        if (e.key === '[') history.back();
        else history.forward();
      } else if (mod && e.shiftKey && k === 'l') {
        e.preventDefault();
        setModal('browse-channels');
      } else if (mod && e.shiftKey && k === 'k') {
        e.preventDefault();
        setModal('browse-dms');
      } else if (mod && e.shiftKey && k === 'e') {
        e.preventDefault();
        setModal('people');
      } else if (mod && e.shiftKey && k === 'i') {
        if (currentCh) {
          e.preventDefault();
          setModal('details');
        }
      } else if (mod && e.shiftKey && k === 'd') {
        e.preventDefault();
        setSidebar((s) => {
          lsSet('sdv.sidebar', s ? 'hidden' : 'shown');
          return !s;
        });
      } else if (mod && e.key === '.') {
        e.preventDefault();
        setPaneHidden((h) => !h);
      } else if (mod && (e.key === '/' || e.key === '?')) {
        e.preventDefault();
        setModal('shortcuts');
      } else if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const order = sidebarOrder(store);
        if (order.length === 0) return;
        const i = currentCh ? order.indexOf(currentCh) : -1;
        const next = e.key === 'ArrowUp' ? (i <= 0 ? order.length - 1 : i - 1) : (i + 1) % order.length;
        navigate({ kind: 'channel', ch: order[next] });
      } else if (e.key === 'F6') {
        e.preventDefault();
        cycleFocus(e.shiftKey);
      } else if (e.key === 'Escape' && !typing && !modal && !lightbox) {
        if (pane && !paneHidden) {
          e.preventDefault();
          closePane();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [currentCh, store, modal, lightbox, pane, paneHidden, closePane, cycleFocus]);

  const onCommand = (cmd: string) => {
    if (cmd === 'search') search.current?.focus();
    else if (cmd === 'unknown-users') navigate({ kind: 'unknown-users' });
    else setModal(cmd as ModalKind);
  };

  const showPane = !paneHidden && ((pane === 'thread' && route.kind === 'channel' && route.thread) || (pane === 'profile' && profile));

  return (
    <UICtx.Provider value={ui}>
      <div className="app">
        <TopBar ref={search} query={route.kind === 'search' ? route.q : ''} onSearch={ui.search} onOpenChannel={(id) => ui.openChannel(id)} onOpenProfile={(id) => ui.openProfile(id)} />
        {store.boot.in_use && <div className="banner">slackdump seems to be running on this archive. What you see may change; restart the viewer when it's done.</div>}
        <div className="workspace">
          {sidebar && <Sidebar current={currentCh} onOpen={(id) => ui.openChannel(id)} onCommand={onCommand} />}
          <main className="main">
            {route.kind === 'channel' && <ChannelView key={route.ch} route={route} listRef={list} onDetails={() => setModal('details')} />}
            {route.kind === 'search' && <SearchPage q={route.q} tab={route.tab} sort={route.sort} />}
            {route.kind === 'unknown-users' && <UnknownUsersPage />}
          </main>
          {showPane && pane === 'thread' && route.kind === 'channel' && route.thread && <ThreadPane ch={route.ch} ts={route.thread} reply={route.reply} onClose={closePane} />}
          {showPane && pane === 'profile' && profile && <ProfilePane id={profile} onClose={() => setPane(null)} />}
        </div>
        {modal === 'switcher' && <QuickSwitcher onClose={() => setModal(null)} />}
        {modal === 'shortcuts' && <ShortcutsHelp onClose={() => setModal(null)} />}
        {modal === 'prefs' && <Prefs onClose={() => setModal(null)} />}
        {modal === 'browse-channels' && <BrowseChannels onClose={() => setModal(null)} />}
        {modal === 'browse-dms' && <BrowseDMs onClose={() => setModal(null)} />}
        {modal === 'people' && <People onClose={() => setModal(null)} />}
        {modal === 'details' && currentCh && <ChannelDetails id={currentCh} onClose={() => setModal(null)} />}
        {lightbox && <Lightbox files={lightbox.files} index={lightbox.index} onClose={() => setLightbox(null)} />}
        {toast && <div className="toast">{toast}</div>}
      </div>
    </UICtx.Provider>
  );
}
