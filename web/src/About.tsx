import { Copy, Hash, Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type AboutResp } from './api';
import { Avatar } from './Avatar';
import { navigate } from './router';
import { useStore } from './store';
import { useUI } from './ui';
import { formatFull, formatSize, tsDate } from './util';

const n = (v?: number) => (v ?? 0).toLocaleString();
const pct = (a: number, b: number) => (b ? ` (${Math.round((a / b) * 100)}%)` : '');
const when = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

function span(first?: string, last?: string) {
  if (!first || !last) return '';
  const days = (tsDate(last).getTime() - tsDate(first).getTime()) / 86400000;
  return days >= 730 ? `${Math.round(days / 365)} years` : days >= 60 ? `${Math.round(days / 30)} months` : `${Math.round(days)} days`;
}

function Path({ p }: { p: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="about-path">
      <span className="mono">{p}</span>
      <button
        className="icon-btn"
        title="Copy path"
        onClick={() => navigator.clipboard?.writeText(p).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1200)))}
      >
        <Copy size={13} />
      </button>
      {copied && <span className="muted small">Copied</span>}
    </span>
  );
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="about-rows">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AboutPage() {
  const store = useStore();
  const ui = useUI();
  const [r, setR] = useState<AboutResp | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.about().then(setR, (e) => setErr(String(e)));
  }, []);
  if (err) return <div className="empty-state">Couldn't load archive details: {err}</div>;
  if (!r) return <div className="empty-state">Loading…</div>;
  const s = r.stats;
  const ws = r.workspace;
  const me = store.person(r.me);
  const maxYear = Math.max(1, ...(s.by_year || []).map((y) => y.count));
  const conv = s.conversations;
  const first = s.sessions[0];
  const al = r.aliases;

  return (
    <div className="about-page">
      <div className="search-head">
        <h1>About this archive</h1>
        <p className="muted">
          A read-only <a href="https://github.com/rusq/slackdump" target="_blank" rel="noreferrer">slackdump</a> archive of <b>{ws.team}</b>, viewed with
          SlackDumpViewer.
        </p>
      </div>
      <div className="about-body">
        <div className="about-tiles">
          <div className="about-tile">
            <div className="about-num">{n(s.messages)}</div>
            <div className="about-label">messages</div>
          </div>
          <div className="about-tile">
            <div className="about-num">{span(s.first_ts, s.last_ts) || '—'}</div>
            <div className="about-label">
              {s.first_ts && s.last_ts ? `${tsDate(s.first_ts).getFullYear()} – ${tsDate(s.last_ts).getFullYear()}` : 'no messages'}
            </div>
          </div>
          <div className="about-tile">
            <div className="about-num">{n(conv.with_messages)}</div>
            <div className="about-label">conversations with messages</div>
          </div>
          <div className="about-tile">
            <div className="about-num">{n(s.users.total)}</div>
            <div className="about-label">people</div>
          </div>
          <div className="about-tile">
            <div className="about-num">{n(s.local_files)}</div>
            <div className="about-label">files downloaded ({formatSize(s.local_bytes) || '0 B'})</div>
          </div>
        </div>

        <section className="about-section">
          <h2>Archive</h2>
          <Rows
            rows={[
              ['Location', <Path p={s.archive_dir} />],
              ['Database', <>{formatSize(s.db_size)} · last changed {when(s.db_modified)}{s.in_use && <span className="badge"> slackdump is running</span>}</>],
              ['Created', first ? <>{when(first.created)} with <span className="mono">{first.command}</span></> : 'unknown'],
              ['Workspace', <>{ws.team} · <a href={ws.url} target="_blank" rel="noreferrer">{ws.url}</a> · <span className="mono">{ws.team_id}</span></>],
              [
                'Exported by',
                <button className="link-btn about-person" onClick={(e) => ui.openProfile(r.me, e.currentTarget)}>
                  <Avatar p={me} size={20} /> {me.name}
                  {ws.username && <span className="muted"> @{ws.username}</span>}
                </button>,
              ],
              ['First message', s.first_ts ? formatFull(s.first_ts) : '—'],
              ['Last message', s.last_ts ? formatFull(s.last_ts) : '—'],
            ]}
          />
        </section>

        <section className="about-section">
          <h2>Messages</h2>
          <Rows
            rows={[
              ['In channels and DMs', n(s.top_level)],
              ['Threads', n(s.threads)],
              ['Thread replies', <>{n(s.replies)}{s.claimed_replies > s.replies && <span className="muted"> of {n(s.claimed_replies)} ({n(s.claimed_replies - s.replies)} never downloaded)</span>}</>],
              ['With files', n(s.with_files) + pct(s.with_files, s.messages)],
              ['With links', n(s.with_links) + pct(s.with_links, s.messages)],
              ['Edited', n(s.edited)],
              ['Pinned', n(s.pinned)],
              ['From bots and apps', n(s.bot)],
              ['Reactions', n(s.reactions)],
            ]}
          />
        </section>

        {s.by_year?.length > 0 && (
          <section className="about-section">
            <h2>Messages by year</h2>
            <div className="about-bars">
              {s.by_year.map((y) => (
                <button key={y.year} className="about-bar-row" title={`Search messages from ${y.year}`} onClick={() => ui.search(`during:${y.year}`)}>
                  <span className="about-bar-label">{y.year}</span>
                  <span className="about-bar-track">
                    <span className="about-bar" style={{ width: `${(y.count / maxYear) * 100}%` }} />
                  </span>
                  <span className="about-bar-value">{n(y.count)}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="about-columns">
          <section className="about-section">
            <h2>Busiest conversations</h2>
            <ol className="about-top">
              {s.top_channels.map(({ id, count }) => {
                const c = store.channels.get(id);
                return (
                  <li key={id}>
                    <button className="link-btn" onClick={() => ui.openChannel(id)}>
                      {c?.kind === 'private' ? <Lock size={13} /> : c?.kind === 'public' ? <Hash size={13} /> : null} {c ? store.channelLabel(c) : id}
                    </button>
                    <span className="about-count">{n(count)}</span>
                  </li>
                );
              })}
            </ol>
          </section>
          <section className="about-section">
            <h2>Most messages sent</h2>
            <ol className="about-top">
              {s.top_posters.map(({ id, count }) => {
                const p = store.person(id);
                return (
                  <li key={id}>
                    <button className="link-btn about-person" onClick={(e) => ui.openProfile(id, e.currentTarget)}>
                      <Avatar p={p} size={18} /> {p.name}
                    </button>
                    <span className="about-count">{n(count)}</span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <div className="about-columns">
          <section className="about-section">
            <h2>Conversations</h2>
            <Rows
              rows={[
                ['Public channels', n(conv.public)],
                ['Private channels', n(conv.private)],
                ['Direct messages', n(conv.im)],
                ['Group DMs', n(conv.mpim)],
                ['Archived', n(conv.archived)],
              ]}
            />
          </section>
          <section className="about-section">
            <h2>People</h2>
            <Rows
              rows={[
                ['Active', n(s.users.active)],
                ['Deactivated', n(s.users.deactivated)],
                ['Bots and apps', n(s.users.bots)],
                ...(s.users.external ? ([['From other workspaces', n(s.users.external)]] as [string, React.ReactNode][]) : []),
                [
                  'Without a profile',
                  <button className="link-btn" onClick={() => navigate({ kind: 'unknown-users' })}>
                    {n(s.unknown_users)} · {n(al.confirmed)} confirmed, {n(al.suggested)} suggested aliases
                  </button>,
                ],
              ]}
            />
          </section>
        </div>

        <section className="about-section">
          <h2>Files and media</h2>
          <Rows
            rows={[
              ['Files shared', <>{n(s.files)}{s.files_bytes ? ` · ${formatSize(s.files_bytes)}` : ''}</>],
              ['Downloaded', <>{n(s.local_files)} files · {formatSize(s.local_bytes) || '0 B'}</>],
              ['Avatars', s.avatars ? n(s.avatars) : <span className="muted">none (slackdump resume -avatars)</span>],
              ['Custom emoji', s.custom_emoji ? n(s.custom_emoji) : <span className="muted">none (slackdump emoji -full)</span>],
            ]}
          />
        </section>

        <section className="about-section">
          <h2>slackdump runs</h2>
          <table className="about-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Finished</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {s.sessions.map((x) => (
                <tr key={x.id}>
                  <td>{when(x.created)}</td>
                  <td>{x.finished ? when(x.updated) : <span className="about-warn">didn't finish</span>}</td>
                  <td className="mono">{x.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="about-section">
          <h2>Viewer files</h2>
          <Rows
            rows={[
              ['Folder', <Path p={r.stats.cache_dir} />],
              ['Search index', formatSize(s.index_size)],
              ['Aliases', <Path p={r.aliases_path} />],
            ]}
          />
        </section>
      </div>
    </div>
  );
}
