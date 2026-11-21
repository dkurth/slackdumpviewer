import { ArrowDown, ChevronDown, Hash, Lock } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { api, type Channel, type Message as Msg } from './api';
import { groupsWith, Message, slackPermalink } from './Message';
import { useStore } from './store';
import { useUI } from './ui';
import { copyText, dayKey, formatDay, formatShortDate, tsDate } from './util';

const START = 10_000_000;
const PAGE = 60;

export type Anchor = { kind: 'latest' } | { kind: 'ts'; ts: string; highlight: boolean } | { kind: 'beginning' };

export interface MessageListHandle {
  focus: () => void;
  jump: (a: Anchor) => void;
}

function DayDivider({ ts, onJump }: { ts: string; onJump: (e: React.MouseEvent) => void }) {
  return (
    <div className="day-divider">
      <button className="day-pill" onClick={onJump}>
        {formatDay(tsDate(ts))} <ChevronDown size={12} />
      </button>
    </div>
  );
}

function JumpMenu({ x, y, onPick, onClose }: { x: number; y: number; onPick: (a: Anchor | Date) => void; onClose: () => void }) {
  const [date, setDate] = useState('');
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  const ago = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d;
  };
  return (
    <div className="menu-backdrop" onClick={onClose}>
      <div className="menu jump-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
        <div className="menu-title">Jump to…</div>
        <button className="menu-item" onClick={() => onPick({ kind: 'latest' })}>
          Most recent
        </button>
        <button className="menu-item" onClick={() => onPick(ago(7))}>
          Last week
        </button>
        <button className="menu-item" onClick={() => onPick(ago(30))}>
          Last month
        </button>
        <button className="menu-item" onClick={() => onPick(ago(365))}>
          Last year
        </button>
        <button className="menu-item" onClick={() => onPick({ kind: 'beginning' })}>
          The very beginning
        </button>
        <div className="menu-sep" />
        <form
          className="menu-date"
          onSubmit={(e) => {
            e.preventDefault();
            if (date) onPick(new Date(date + 'T00:00:00'));
          }}
        >
          <label>Jump to a specific date</label>
          <div className="menu-date-row">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} autoFocus />
            <button type="submit" className="btn btn-primary btn-small" disabled={!date}>
              Go
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ChannelIntro({ c }: { c: Channel }) {
  const { channelLabel, person } = useStore();
  const dm = c.kind === 'im' || c.kind === 'mpim';
  return (
    <div className="channel-intro">
      <h2>
        {dm ? '' : c.kind === 'private' ? <Lock size={22} /> : <Hash size={22} />}
        {channelLabel(c)}
      </h2>
      <p>
        {dm ? (
          <>This is the very beginning of your direct message history{c.kind === 'im' ? <> with <b>{channelLabel(c)}</b></> : null}.</>
        ) : (
          <>
            This is the very beginning of the <b>{c.name}</b> channel
            {c.creator ? <> , created by {person(c.creator).name}</> : null}
            {c.created ? <> on {formatShortDate(c.created)}</> : null}.
          </>
        )}
        {c.purpose ? <> {c.purpose}</> : null}
      </p>
    </div>
  );
}

export const MessageList = forwardRef<MessageListHandle, { channel: Channel; anchor: Anchor }>(function MessageList({ channel, anchor: initialAnchor }, ref) {
  const { boot } = useStore();
  const ui = useUI();
  const [anchor, setAnchor] = useState<Anchor>(initialAnchor);
  const [nonce, setNonce] = useState(0);
  useEffect(() => setAnchor(initialAnchor), [initialAnchor]);

  const jump = useCallback((a: Anchor) => {
    setAnchor(a);
    setNonce((n) => n + 1);
  }, []);

  const inner = useRef<InnerHandle>(null);
  useImperativeHandle(ref, () => ({ focus: () => inner.current?.focus(), jump }), [jump]);

  return <Inner key={`${channel.id}|${JSON.stringify(anchor)}|${nonce}`} ref={inner} channel={channel} anchor={anchor} jump={jump} teamURL={boot.workspace.url} ui={ui} />;
});

interface InnerHandle {
  focus: () => void;
}

const Inner = forwardRef<InnerHandle, { channel: Channel; anchor: Anchor; jump: (a: Anchor) => void; teamURL: string; ui: ReturnType<typeof useUI> }>(function Inner(
  { channel, anchor, jump, teamURL, ui },
  ref,
) {
  const [items, setItems] = useState<Msg[] | null>(null);
  const [first, setFirst] = useState(START);
  const [moreBefore, setMoreBefore] = useState(false);
  const [moreAfter, setMoreAfter] = useState(false);
  const [initialIndex, setInitialIndex] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [topTs, setTopTs] = useState<string | null>(null);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<string | null>(anchor.kind === 'ts' && anchor.highlight ? anchor.ts : null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const loading = useRef({ before: false, after: false });
  const virt = useRef<VirtuosoHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => box.current?.focus() }), []);

  // initial load
  useEffect(() => {
    const ac = new AbortController();
    const p =
      anchor.kind === 'latest'
        ? api.messages(channel.id, { limit: PAGE }, ac.signal)
        : anchor.kind === 'beginning'
          ? api.messages(channel.id, { after: '0', limit: PAGE }, ac.signal)
          : api.messages(channel.id, { around: anchor.ts, limit: PAGE }, ac.signal);
    p.then((r) => {
      let idx = r.messages.length - 1;
      if (anchor.kind === 'beginning') idx = 0;
      if (anchor.kind === 'ts') {
        const t = parseFloat(anchor.ts);
        idx = r.messages.findIndex((m) => parseFloat(m.ts) >= t);
        if (idx < 0) idx = r.messages.length - 1;
      }
      setInitialIndex(Math.max(0, idx));
      setItems(r.messages);
      setMoreBefore(r.has_more_before);
      setMoreAfter(r.has_more_after);
      setFirst(START);
    }).catch((e) => {
      if (e.name !== 'AbortError') setError(String(e.message || e));
    });
    return () => ac.abort();
  }, [channel.id, anchor]);

  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(t);
  }, [highlight]);

  const loadOlder = useCallback(() => {
    if (!items || !moreBefore || loading.current.before || items.length === 0) return;
    loading.current.before = true;
    api
      .messages(channel.id, { before: items[0].ts, limit: PAGE })
      .then((r) => {
        setFirst((f) => f - r.messages.length);
        setItems((cur) => [...r.messages, ...(cur || [])]);
        setMoreBefore(r.has_more_before);
      })
      .finally(() => (loading.current.before = false));
  }, [items, moreBefore, channel.id]);

  const loadNewer = useCallback(() => {
    if (!items || !moreAfter || loading.current.after || items.length === 0) return;
    loading.current.after = true;
    api
      .messages(channel.id, { after: items[items.length - 1].ts, limit: PAGE })
      .then((r) => {
        setItems((cur) => [...(cur || []), ...r.messages]);
        setMoreAfter(r.has_more_after);
      })
      .finally(() => (loading.current.after = false));
  }, [items, moreAfter, channel.id]);

  const pickJump = (a: Anchor | Date) => {
    setMenu(null);
    if (a instanceof Date) jump({ kind: 'ts', ts: String(a.getTime() / 1000), highlight: false });
    else jump(a);
  };

  const openMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left + r.width / 2 - 130, y: r.bottom + 4 });
  };

  const focusAt = (abs: number) => {
    if (!items) return;
    const clamped = Math.max(first, Math.min(first + items.length - 1, abs));
    setFocusIdx(clamped);
    virt.current?.scrollIntoView({ index: clamped - first, behavior: 'auto' });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!items || e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    const cur = focusIdx ?? first + items.length;
    const m = focusIdx !== null ? items[focusIdx - first] : undefined;
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        focusAt(cur - 1);
        if (cur - 1 - first < 5) loadOlder();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (focusIdx === null) return;
        focusAt(cur + 1);
        if (first + items.length - cur < 5) loadNewer();
        break;
      case 'Enter':
      case 't':
      case 'T':
        if (m && (m.reply_count || m._parent)) {
          e.preventDefault();
          ui.openThread(m._ch, m._parent || m.ts, m._parent ? m.ts : undefined);
        }
        break;
      case 'l':
      case 'L':
        if (m) {
          copyText(slackPermalink(teamURL, m._ch, m.ts, m._parent));
          ui.toast('Link copied');
        }
        break;
      case 'Home':
        e.preventDefault();
        jump({ kind: 'beginning' });
        break;
      case 'End':
        e.preventDefault();
        if (moreAfter) jump({ kind: 'latest' });
        else virt.current?.scrollToIndex({ index: items.length - 1, align: 'end' });
        break;
      case 'PageUp':
        e.preventDefault();
        virt.current?.scrollBy({ top: -(box.current?.clientHeight || 600) * 0.85 });
        break;
      case 'PageDown':
        e.preventDefault();
        virt.current?.scrollBy({ top: (box.current?.clientHeight || 600) * 0.85 });
        break;
      case 'Escape':
        setFocusIdx(null);
        break;
    }
  };

  const components = useMemo(
    () => ({
      Header: () =>
        moreBefore ? (
          <div className="list-loading">Loading older messages…</div>
        ) : (
          <ChannelIntro c={channel} />
        ),
      Footer: () => (moreAfter ? <div className="list-loading">Loading newer messages…</div> : <div style={{ height: 16 }} />),
    }),
    [moreBefore, moreAfter, channel],
  );

  if (error) return <div className="empty-state">Couldn't load messages: {error}</div>;
  if (!items) return <div className="empty-state">Loading…</div>;

  return (
    <div className="message-list" ref={box} tabIndex={0} onKeyDown={onKey} aria-label="Messages">
      {items.length === 0 ? (
        <div className="message-scroll-empty">
          <ChannelIntro c={channel} />
          <div className="empty-state small">No messages in the archive for this conversation.</div>
        </div>
      ) : (
        <Virtuoso
          ref={virt}
          className="virtuoso"
          data={items}
          firstItemIndex={first}
          initialTopMostItemIndex={{ index: initialIndex, align: anchor.kind === 'ts' ? 'center' : anchor.kind === 'beginning' ? 'start' : 'end' }}
          alignToBottom
          startReached={loadOlder}
          endReached={loadNewer}
          atBottomStateChange={setAtBottom}
          atBottomThreshold={200}
          increaseViewportBy={{ top: 1200, bottom: 800 }}
          computeItemKey={(_, m) => m.ts}
          rangeChanged={(r) => {
            const m = items[Math.max(0, r.startIndex - first)];
            if (m) setTopTs(m.ts);
          }}
          components={components}
          itemContent={(abs, m) => {
            const i = abs - first;
            const prev = i > 0 ? items[i - 1] : undefined;
            const newDay = !prev || dayKey(prev.ts) !== dayKey(m.ts);
            return (
              <div className="msg-wrap">
                {newDay && <DayDivider ts={m.ts} onJump={openMenu} />}
                <Message m={m} grouped={!newDay && groupsWith(prev, m)} highlighted={highlight === m.ts || (highlight !== null && Math.abs(parseFloat(highlight) - parseFloat(m.ts)) < 0.0000005)} focused={focusIdx === abs} onClick={() => setFocusIdx(abs)} />
              </div>
            );
          }}
        />
      )}
      {topTs && items.length > 0 && (
        <div className="floating-day">
          <button className="day-pill" onClick={openMenu}>
            {formatDay(tsDate(topTs))} <ChevronDown size={12} />
          </button>
        </div>
      )}
      {(moreAfter || !atBottom) && items.length > 0 && (
        <button
          className="jump-latest"
          onClick={() => {
            if (moreAfter) jump({ kind: 'latest' });
            else virt.current?.scrollToIndex({ index: items.length - 1, align: 'end', behavior: 'smooth' });
          }}
        >
          <ArrowDown size={14} /> Jump to recent messages
        </button>
      )}
      {menu && <JumpMenu x={menu.x} y={menu.y} onPick={pickJump} onClose={() => setMenu(null)} />}
    </div>
  );
});
