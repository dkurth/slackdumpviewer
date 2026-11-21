import { ArrowUp, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, type ThreadResp } from './api';
import { groupsWith, Message } from './Message';
import { useStore } from './store';
import { useUI } from './ui';

export function ThreadPane({ ch, ts, reply, onClose }: { ch: string; ts: string; reply?: string; onClose: () => void }) {
  const { channels, channelLabel } = useStore();
  const ui = useUI();
  const [data, setData] = useState<ThreadResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | undefined>(reply);
  const scroller = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  const c = channels.get(ch);

  useEffect(() => {
    setData(null);
    setError(null);
    const ac = new AbortController();
    api
      .thread(ch, ts, ac.signal)
      .then(setData)
      .catch((e) => e.name !== 'AbortError' && setError(String(e.message || e)));
    return () => ac.abort();
  }, [ch, ts]);

  useEffect(() => setHighlight(reply), [reply]);
  useEffect(() => {
    if (!highlight) return;
    const t = setTimeout(() => setHighlight(undefined), 4000);
    return () => clearTimeout(t);
  }, [highlight]);

  // Open at the most recent reply (or the linked reply), like Slack.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !data) return;
    const target = reply ? el.querySelector(`[data-ts="${CSS.escape(reply)}"]`) : null;
    if (target) (target as HTMLElement).scrollIntoView({ block: 'center' });
    else el.scrollTop = el.scrollHeight;
    setOverflowing(el.scrollHeight > el.clientHeight + 4);
    // images may load later and change height; keep pinned to bottom on first paint
    const imgs = Array.from(el.querySelectorAll('img'));
    const onLoad = () => {
      if (!reply && el.scrollHeight - el.scrollTop - el.clientHeight < 400) el.scrollTop = el.scrollHeight;
      setOverflowing(el.scrollHeight > el.clientHeight + 4);
    };
    imgs.forEach((i) => i.addEventListener('load', onLoad, { once: true }));
    return () => imgs.forEach((i) => i.removeEventListener('load', onLoad));
  }, [data, reply]);

  const parent = data?.parent;
  const replies = data?.replies || [];
  const claimed = parent?.reply_count || replies.length;
  return (
    <aside className="side-pane thread-pane" aria-label="Thread">
      <header className="pane-header">
        <div>
          <div className="pane-title">Thread</div>
          {c && (
            <button className="pane-sub link-btn" onClick={() => ui.openChannel(ch)}>
              {c.kind === 'public' || c.kind === 'private' ? '# ' : ''}
              {channelLabel(c)}
            </button>
          )}
        </div>
        <button className="icon-btn" onClick={onClose} title="Close (Esc)">
          <X size={18} />
        </button>
      </header>
      <div className="pane-body" ref={scroller} tabIndex={0}>
        {error && <div className="empty-state">Couldn't load thread: {error}</div>}
        {!data && !error && <div className="empty-state">Loading…</div>}
        {data && (
          <>
            {overflowing && (
              <button className="jump-top" onClick={() => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' })}>
                <ArrowUp size={13} /> Jump to the beginning of the thread
              </button>
            )}
            {parent ? (
              <Message m={parent} inThread highlighted={highlight === parent.ts} />
            ) : (
              <div className="msg-deleted thread-parent-missing">The original message isn't in the archive.</div>
            )}
            <div className="thread-sep">
              <span>
                {claimed} {claimed === 1 ? 'reply' : 'replies'}
              </span>
            </div>
            {replies.length < claimed && (
              <div className="thread-gap-note">
                Only {replies.length} of {claimed} replies are in this archive. The rest weren't downloaded by slackdump.
              </div>
            )}
            {replies.map((m, i) => (
              <Message key={m.ts} m={m} inThread grouped={groupsWith(i > 0 ? replies[i - 1] : undefined, m)} highlighted={highlight === m.ts} />
            ))}
            <div style={{ height: 24 }} />
          </>
        )}
      </div>
    </aside>
  );
}
