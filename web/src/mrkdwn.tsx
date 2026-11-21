// Slack mrkdwn → React.
import { Fragment, type ReactNode } from 'react';
import { Emoji } from './emoji';
import { internalPath, navigate } from './router';
import { useStore } from './store';
import { useHighlight, useUI } from './ui';
import { formatFull, tsDate } from './util';

export function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// ---------- highlighting ----------

function stripDiacritics(s: string) {
  return s.normalize('NFD').replace(/\p{Mn}/gu, '');
}

function highlightRegex(terms: string[]): RegExp | null {
  const parts = terms
    .filter((t) => t.length > 0)
    .map((t) => {
      let base = stripDiacritics(t.toLowerCase());
      // crude stemming so "deploys" highlights "deployed"
      if (base.length > 4) base = base.replace(/(ing|ed|es|s)$/, '');
      return base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
  if (parts.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(${parts.join('|')})[\\p{L}\\p{N}]*`, 'giu');
}

export function Highlighted({ text }: { text: string }) {
  const terms = useHighlight();
  if (!terms.length || !text) return <>{text}</>;
  const re = highlightRegex(terms);
  if (!re) return <>{text}</>;
  // Match on a diacritic-stripped copy; NFD stripping can change length, so
  // only use it when lengths agree.
  const folded = stripDiacritics(text);
  const src = folded.length === text.length ? folded : text;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={m.index} className="hl">
        {text.slice(m.index, m.index + m[0].length)}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

function TextWithBreaks({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((l, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          <Highlighted text={l} />
        </Fragment>
      ))}
    </>
  );
}

// ---------- atoms ----------

export function UserMention({ id, fallback }: { id: string; fallback?: string }) {
  const { person, me } = useStore();
  const ui = useUI();
  const p = person(id);
  const name = p.unknown && fallback ? fallback : p.name;
  return (
    <button
      type="button"
      className={'mention' + (id === me ? ' mention-me' : '')}
      onClick={(e) => {
        e.stopPropagation();
        ui.openProfile(id, e.currentTarget);
      }}
    >
      @{name}
    </button>
  );
}

export function ChannelMention({ id, fallback }: { id: string; fallback?: string }) {
  const { channels, channelLabel } = useStore();
  const ui = useUI();
  const c = channels.get(id);
  const label = c ? channelLabel(c) : fallback || id;
  return (
    <button
      type="button"
      className="mention channel-mention"
      onClick={(e) => {
        e.stopPropagation();
        if (c) ui.openChannel(id);
      }}
      title={c ? undefined : 'This conversation is not in the archive'}
    >
      {c && c.kind !== 'im' && c.kind !== 'mpim' ? '#' : ''}
      {label}
    </button>
  );
}

export function Link({ href, children }: { href: string; children: ReactNode }) {
  const { teamHost } = useStore();
  const internal = internalPath(href, teamHost);
  if (internal) {
    return (
      <a
        href={internal}
        className="link"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          navigate(internal);
        }}
      >
        {children}
      </a>
    );
  }
  let safe = href;
  if (!/^(https?|mailto|ftp|tel):/i.test(href)) safe = '#';
  return (
    <a href={safe} className="link" target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      {children}
    </a>
  );
}

function formatSlackDate(ts: number, fmt: string, fallback: string, link?: string): ReactNode {
  const d = tsDate(ts);
  if (isNaN(d.getTime())) return fallback;
  const rep: Record<string, string> = {
    '{date_num}': d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }),
    '{date_slash}': d.toLocaleDateString(),
    '{date}': d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }),
    '{date_short}': d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    '{date_long}': d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    '{date_pretty}': d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }),
    '{date_short_pretty}': d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    '{date_long_pretty}': d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
    '{time}': d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    '{time_secs}': d.toLocaleTimeString(),
    '{ago}': d.toLocaleString(),
  };
  const text = fmt.replace(/\{[a-z_]+\}/g, (k) => rep[k] ?? k);
  const node = (
    <span className="slack-date" title={formatFull(ts)}>
      {text}
    </span>
  );
  return link ? <Link href={link}>{node}</Link> : node;
}

function Atom({ raw }: { raw: string }) {
  if (raw.startsWith('`')) return <code className="inline-code">{decodeEntities(raw.slice(1, -1))}</code>;
  if (raw.startsWith(':')) return <Emoji name={raw.slice(1, -1)} />;
  const inner = raw.slice(1, -1);
  const bar = inner.indexOf('|');
  const target = bar >= 0 ? inner.slice(0, bar) : inner;
  const label = bar >= 0 ? decodeEntities(inner.slice(bar + 1)) : '';
  if (target.startsWith('@')) return <UserMention id={target.slice(1)} fallback={label} />;
  if (target.startsWith('#')) return <ChannelMention id={target.slice(1)} fallback={label} />;
  if (target.startsWith('!')) {
    const t = target.slice(1);
    if (t === 'here' || t === 'channel' || t === 'everyone') return <span className="mention broadcast">@{t}</span>;
    if (t.startsWith('subteam^')) return <span className="mention">{label || '@group'}</span>;
    if (t.startsWith('date^')) {
      const [, ts, fmt, link] = t.split('^');
      return <>{formatSlackDate(Number(ts), fmt || '{date}', label, link)}</>;
    }
    return <span>{label || t}</span>;
  }
  const href = decodeEntities(target);
  const text = label || href.replace(/^mailto:/, '');
  return (
    <Link href={href}>
      <Highlighted text={text} />
    </Link>
  );
}

// ---------- inline styles ----------

const ATOM_RE = /<[^<>\n]+>|`[^`\n]+`|:[a-z0-9_+'\-]+(?:::skin-tone-[2-6])?:/g;
const PH_RE = /\u0001(\d+)\u0002/g;

function styleRe(m: string): RegExp {
  const e = m === '*' ? '\\*' : m;
  return new RegExp(`(^|[^\\p{L}\\p{N}${e}])${e}(?=\\S)([^\\n]*?[^\\s])${e}(?![\\p{L}\\p{N}${e}])`, 'u');
}
const STYLES: { re: RegExp; tag: 'b' | 'i' | 's' }[] = [
  { re: styleRe('*'), tag: 'b' },
  { re: styleRe('_'), tag: 'i' },
  { re: styleRe('~'), tag: 's' },
];

function leaf(s: string, atoms: string[], key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PH_RE.lastIndex = 0;
  let i = 0;
  while ((m = PH_RE.exec(s))) {
    if (m.index > last) out.push(<TextWithBreaks key={`${key}t${i++}`} text={decodeEntities(s.slice(last, m.index))} />);
    out.push(<Atom key={`${key}a${i++}`} raw={atoms[Number(m[1])]} />);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(<TextWithBreaks key={`${key}t${i++}`} text={decodeEntities(s.slice(last))} />);
  return out;
}

function styled(s: string, atoms: string[], key = 's'): ReactNode[] {
  let best: { idx: number; m: RegExpExecArray; tag: 'b' | 'i' | 's' } | null = null;
  for (const st of STYLES) {
    const m = st.re.exec(s);
    if (m) {
      const idx = m.index + m[1].length;
      if (!best || idx < best.idx) best = { idx, m, tag: st.tag };
    }
  }
  if (!best) return leaf(s, atoms, key);
  const { m, tag, idx } = best;
  const before = s.slice(0, idx);
  const inner = m[2];
  const after = s.slice(m.index + m[0].length);
  const Tag = tag;
  return [
    ...leaf(before, atoms, key + 'b'),
    <Tag key={key + 'x'}>{styled(inner, atoms, key + 'i')}</Tag>,
    ...styled(after, atoms, key + 'r'),
  ];
}

export function Inline({ text }: { text: string }) {
  const atoms: string[] = [];
  const s = text.replace(ATOM_RE, (m) => {
    atoms.push(m);
    return `\u0001${atoms.length - 1}\u0002`;
  });
  return <>{styled(s, atoms)}</>;
}

// ---------- blocks: code, quotes ----------

export function Mrkdwn({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const parts: ReactNode[] = [];
  const re = /```([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(<Lines key={k++} text={text.slice(last, m.index)} />);
    parts.push(
      <pre key={k++} className="code-block">
        {decodeEntities(m[1].replace(/^\n/, ''))}
      </pre>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<Lines key={k++} text={text.slice(last)} />);
  return <div className={'mrkdwn ' + (className || '')}>{parts}</div>;
}

function Lines({ text }: { text: string }) {
  // Group "> quoted" lines; "&gt;&gt;&gt;" quotes the rest.
  const lines = text.replace(/^\n|\n$/g, '').split('\n');
  const out: ReactNode[] = [];
  let buf: string[] = [];
  let quote: string[] = [];
  let k = 0;
  const flushBuf = () => {
    if (buf.length) out.push(<Inline key={k++} text={buf.join('\n')} />);
    buf = [];
  };
  const flushQuote = () => {
    if (quote.length)
      out.push(
        <blockquote key={k++}>
          <Inline text={quote.join('\n')} />
        </blockquote>,
      );
    quote = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('&gt;&gt;&gt;')) {
      flushBuf();
      quote.push(l.slice(12).trimStart(), ...lines.slice(i + 1));
      break;
    }
    if (l.startsWith('&gt;') || l.startsWith('>')) {
      flushBuf();
      quote.push(l.replace(/^(&gt;|>) ?/, ''));
    } else {
      flushQuote();
      buf.push(l);
    }
  }
  flushBuf();
  flushQuote();
  return <>{out}</>;
}

/** Plain text (no formatting) of mrkdwn, for snippets and tooltips. */
export function mrkdwnPlain(text: string, userName: (id: string) => string): string {
  return decodeEntities(
    text
      .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id, l) => '@' + (l || userName(id)))
      .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
      .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
      .replace(/<[^|>]+\|([^>]+)>/g, '$1')
      .replace(/<([^>]+)>/g, '$1'),
  );
}
