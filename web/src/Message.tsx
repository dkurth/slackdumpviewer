import { Copy, Link2, MessageSquareText, Pin } from 'lucide-react';
import { memo } from 'react';
import type { Message as Msg, Reaction } from './api';
import { Attachments } from './Attachments';
import { Avatar } from './Avatar';
import { Blocks, hasRenderableBlocks } from './blocks';
import { Emoji } from './emoji';
import { Files } from './Files';
import { Mrkdwn, mrkdwnPlain } from './mrkdwn';
import { useStore } from './store';
import { useUI } from './ui';
import { copyText, formatFull, formatShortDate, formatTime, relative } from './util';

const SYSTEM_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'group_join', 'group_leave', 'channel_topic', 'channel_purpose', 'channel_name',
  'channel_archive', 'channel_unarchive', 'group_archive', 'group_unarchive', 'bot_add', 'bot_remove', 'pinned_item',
  'unpinned_item', 'sh_room_created', 'sh_room_shared', 'reminder_add', 'tabbed_canvas_updated', 'mpdm_move', 'retention_threshold',
  'channel_convert_to_private', 'channel_convert_to_public', 'group_topic', 'group_purpose', 'group_name',
]);

export function isSystem(m: Msg) {
  return !!m.subtype && SYSTEM_SUBTYPES.has(m.subtype);
}

export function slackPermalink(teamURL: string, ch: string, ts: string, threadTs?: string) {
  const base = teamURL.replace(/\/$/, '');
  return `${base}/archives/${ch}/p${ts.replace('.', '')}${threadTs && threadTs !== ts ? `?thread_ts=${threadTs}&cid=${ch}` : ''}`;
}

/** Messages from the same author within 5 minutes collapse their header. */
export function groupsWith(prev: Msg | undefined, m: Msg): boolean {
  if (!prev) return false;
  if (isSystem(prev) || isSystem(m)) return false;
  if ((prev.user || prev.bot_id) !== (m.user || m.bot_id)) return false;
  if ((prev.username || '') !== (m.username || '')) return false;
  if (m.subtype === 'thread_broadcast' || prev.subtype === 'thread_broadcast') return false;
  if (prev.reply_count && prev.reply_count > 0 && !prev._parent) return false;
  return parseFloat(m.ts) - parseFloat(prev.ts) < 300;
}

function Reactions({ list }: { list: Reaction[] }) {
  const { person, me } = useStore();
  return (
    <div className="reactions">
      {list.map((r) => {
        const names = (r.users || []).map((u) => (u === me ? 'You' : person(u).name));
        const extra = r.count - names.length;
        const who = names.join(', ') + (extra > 0 ? ` and ${extra} other${extra > 1 ? 's' : ''}` : '');
        const mine = r.users?.includes(me);
        return (
          <span key={r.name} className={'reaction' + (mine ? ' mine' : '')} title={`${who} reacted with :${r.name}:`}>
            <Emoji name={r.name} size="reaction" />
            <span className="reaction-count">{r.count}</span>
          </span>
        );
      })}
    </div>
  );
}

function ThreadSummary({ m, onOpen }: { m: Msg; onOpen: () => void }) {
  const { person } = useStore();
  const n = m.reply_count || 0;
  const archived = m._archived_replies;
  const users = (m.reply_users || []).slice(0, 5);
  return (
    <button className="thread-summary" onClick={(e) => (e.stopPropagation(), onOpen())}>
      <span className="thread-avatars">
        {users.map((u) => (
          <Avatar key={u} p={person(u)} size={24} />
        ))}
      </span>
      <span className="thread-count">
        {n} {n === 1 ? 'reply' : 'replies'}
      </span>
      {archived !== undefined && archived < n && (
        <span className="thread-missing" title={`Only ${archived} of ${n} replies are in the archive`}>
          ({archived} archived)
        </span>
      )}
      <span className="thread-last">{m.latest_reply && m.latest_reply !== '0000000000.000000' ? `Last reply ${relative(m.latest_reply)}` : 'View thread'}</span>
      <span className="thread-view">View thread</span>
    </button>
  );
}

function systemText(m: Msg): string | null {
  switch (m.subtype) {
    case 'channel_join':
    case 'group_join':
      return 'joined the channel';
    case 'channel_leave':
    case 'group_leave':
      return 'left the channel';
    default:
      return null;
  }
}

export interface MessageProps {
  m: Msg;
  grouped?: boolean;
  highlighted?: boolean;
  focused?: boolean;
  inThread?: boolean;
  showChannel?: boolean;
  onClick?: () => void;
}

function MessageImpl({ m, grouped, highlighted, focused, inThread, showChannel, onClick }: MessageProps) {
  const { personFor, prefs, boot, channels, channelLabel, person } = useStore();
  const ui = useUI();
  const p = personFor(m);
  const sys = isSystem(m);
  const threadTs = m._parent || (m.reply_count ? m.ts : undefined);
  const openThread = () => ui.openThread(m._ch, m._parent || m.ts, m._parent ? m.ts : undefined);
  const profile = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (m.user && !m.bot_id) ui.openProfile(m.user, e.currentTarget);
  };
  const ch = channels.get(m._ch);

  const time = (
    <a
      className="msg-time"
      href={`/client/${m._ch}/${m.ts}`}
      title={formatFull(m.ts, prefs.clock24)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (m._parent && !inThread) ui.openThread(m._ch, m._parent, m.ts);
        else ui.openChannel(m._ch, m.ts);
      }}
    >
      {showChannel ? `${formatShortDate(m.ts)} ${formatTime(m.ts, prefs.clock24)}` : formatTime(m.ts, prefs.clock24)}
    </a>
  );

  let body: React.ReactNode;
  if (m.subtype === 'tombstone' || (m.hidden && m.text === 'This message was deleted.')) {
    body = <div className="msg-deleted">This message was deleted.</div>;
  } else if (sys) {
    const t = systemText(m);
    body = t ? <div className="msg-system">{t}</div> : <Mrkdwn text={m.text || ''} className="msg-system" />;
  } else if (hasRenderableBlocks(m.blocks)) {
    body = <Blocks blocks={m.blocks!} />;
  } else {
    body = <Mrkdwn text={m.text || ''} />;
  }

  const cls = ['msg', grouped ? 'grouped' : '', sys ? 'system' : '', highlighted ? 'highlighted' : '', focused ? 'focused' : '', m.pinned_to?.length ? 'pinned' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      data-ts={m.ts}
      onClick={onClick}
    >
      {m.pinned_to?.length ? (
        <div className="msg-pinned-label">
          <Pin size={12} /> Pinned
        </div>
      ) : null}
      {m.subtype === 'thread_broadcast' && !inThread && (
        <div className="msg-broadcast-label">
          replied to a thread:{' '}
          <button className="link-btn" onClick={(e) => (e.stopPropagation(), openThread())}>
            view thread
          </button>
        </div>
      )}
      {showChannel && ch && (
        <div className="msg-channel-label">
          {ch.kind === 'im' ? 'Direct message with ' : ch.kind === 'mpim' ? 'Group DM with ' : ch.kind === 'private' ? '🔒 ' : '# '}
          {channelLabel(ch)}
          {m._parent ? ' · thread reply' : ''}
        </div>
      )}
      <div className="msg-row">
        <div className="msg-gutter">{grouped ? <span className="msg-gutter-time">{time}</span> : <Avatar p={p} size={sys ? 24 : 36} onClick={profile} />}</div>
        <div className="msg-content">
          {!grouped && (
            <div className="msg-header">
              <button className="msg-author" onClick={profile}>
                {p.name}
              </button>
              {p.bot && <span className="badge">APP</span>}
              {p.oldAccount && (
                <span className={'badge badge-old' + (p.suggested ? ' suggested' : '')} title={p.suggested ? 'Suggested alias (not confirmed)' : `Old account ${p.id}`}>
                  {p.suggested ? 'old account?' : 'old account'}
                </span>
              )}
              {p.user?.external && <span className="badge">EXTERNAL</span>}
              {p.unknown && !p.bot && <span className="badge badge-unknown">no profile</span>}
              {time}
            </div>
          )}
          <div className="msg-body">
            {body}
            {m.edited && !sys && <span className="msg-edited" title={m.edited.ts ? `Edited ${formatFull(m.edited.ts)}` : undefined}>(edited)</span>}
          </div>
          {m.files && m.files.length > 0 && <Files files={m.files} />}
          {m.attachments && m.attachments.length > 0 && <Attachments list={m.attachments} />}
          {m.reactions && m.reactions.length > 0 && <Reactions list={m.reactions} />}
          {!inThread && !m._parent && (m.reply_count || 0) > 0 && <ThreadSummary m={m} onOpen={openThread} />}
          {m.subtype === 'channel_join' && m.inviter && <div className="msg-system-sub">Added by {person(m.inviter).name}</div>}
        </div>
      </div>
      {!sys && (
        <div className="msg-toolbar" onClick={(e) => e.stopPropagation()}>
          {!inThread && (threadTs || m.reply_count) ? (
            <button className="icon-btn" title="View thread" onClick={openThread}>
              <MessageSquareText size={16} />
            </button>
          ) : null}
          <button
            className="icon-btn"
            title="Copy link (Slack permalink — also opens in this viewer)"
            onClick={() => {
              copyText(slackPermalink(boot.workspace.url, m._ch, m.ts, m._parent));
              ui.toast('Link copied');
            }}
          >
            <Link2 size={16} />
          </button>
          <button
            className="icon-btn"
            title="Copy text"
            onClick={() => {
              copyText(mrkdwnPlain(m.text || '', (id) => person(id).name));
              ui.toast('Text copied');
            }}
          >
            <Copy size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

export const Message = memo(MessageImpl);
