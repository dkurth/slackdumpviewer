// Renders Slack rich_text blocks and enough Block Kit for bot messages.
import type { ReactNode } from 'react';
import type { Block } from './api';
import { Emoji } from './emoji';
import { ChannelMention, Highlighted, Link, Mrkdwn, UserMention } from './mrkdwn';
import { useStore } from './store';
import { formatFull, tsDate } from './util';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = any;

function styleWrap(node: ReactNode, style: El, key: string | number): ReactNode {
  if (!style) return node;
  let n = node;
  if (style.code) n = <code className="inline-code">{n}</code>;
  if (style.strike) n = <s>{n}</s>;
  if (style.italic) n = <i>{n}</i>;
  if (style.bold) n = <b>{n}</b>;
  return <span key={key}>{n}</span>;
}

function TextRun({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <>
      {lines.map((l, i) => (
        <span key={i}>
          {i > 0 && <br />}
          <Highlighted text={l} />
        </span>
      ))}
    </>
  );
}

function InlineEl({ el, k }: { el: El; k: number }) {
  switch (el.type) {
    case 'text':
      return <>{styleWrap(<TextRun text={el.text || ''} />, el.style, k)}</>;
    case 'link':
      return <>{styleWrap(<Link href={el.url}>{el.text ? <TextRun text={el.text} /> : <Highlighted text={el.url} />}</Link>, el.style, k)}</>;
    case 'emoji':
      return <Emoji name={el.name + (el.skin_tone ? `::skin-tone-${el.skin_tone}` : '')} unicode={el.unicode} />;
    case 'user':
      return <UserMention id={el.user_id} />;
    case 'channel':
      return <ChannelMention id={el.channel_id} />;
    case 'usergroup':
      return <span className="mention">@{el.usergroup_id}</span>;
    case 'broadcast':
      return <span className="mention broadcast">@{el.range}</span>;
    case 'date': {
      const d = tsDate(el.timestamp);
      return (
        <span className="slack-date" title={formatFull(el.timestamp)}>
          {el.fallback && isNaN(d.getTime()) ? el.fallback : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      );
    }
    case 'color':
      return (
        <span className="color-chip">
          <span style={{ background: el.value }} />
          {el.value}
        </span>
      );
    case 'team':
      return <span className="mention">@{el.team_id}</span>;
    case 'rich_text_section':
      return <Section els={el.elements} />;
    default:
      if (el.text) return <TextRun text={el.text} />;
      if (el.fallback) return <>{el.fallback}</>;
      return null;
  }
}

function Section({ els }: { els: El[] }) {
  return (
    <>
      {(els || []).map((e, i) => (
        <InlineEl key={i} el={e} k={i} />
      ))}
    </>
  );
}

function RichTextList({ el }: { el: El }) {
  const Tag = el.style === 'ordered' ? 'ol' : 'ul';
  const indent = el.indent || 0;
  return (
    <Tag className={`rt-list rt-indent-${Math.min(indent, 6)} ${el.style === 'ordered' ? `rt-ol-${indent % 3}` : `rt-ul-${indent % 3}`}`} start={el.offset ? el.offset + 1 : undefined}>
      {(el.elements || []).map((item: El, i: number) => (
        <li key={i}>
          <Section els={item.elements} />
        </li>
      ))}
    </Tag>
  );
}

export function RichText({ block }: { block: Block }) {
  const els: El[] = block.elements || [];
  return (
    <div className="rich-text">
      {els.map((el, i) => {
        switch (el.type) {
          case 'rich_text_section':
            return (
              <div key={i} className="rt-section">
                <Section els={el.elements} />
              </div>
            );
          case 'rich_text_list':
            return <RichTextList key={i} el={el} />;
          case 'rich_text_preformatted':
            return (
              <pre key={i} className="code-block">
                <Section els={el.elements} />
              </pre>
            );
          case 'rich_text_quote':
            return (
              <blockquote key={i}>
                <Section els={el.elements} />
              </blockquote>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

function TextObj({ t }: { t: El }) {
  if (!t) return null;
  if (t.type === 'mrkdwn') return <Mrkdwn text={t.text || ''} />;
  return (
    <span className="plain">
      <TextRun text={t.text || ''} />
    </span>
  );
}

function ExternalImage({ url, alt, className }: { url: string; alt?: string; className?: string }) {
  const { prefs } = useStore();
  if (!url) return null;
  if (!prefs.externalImages) {
    return (
      <a className="ext-image-placeholder" href={url} target="_blank" rel="noopener noreferrer" title="Images from the web are off (Preferences)">
        🖼 {alt || 'Image'}
      </a>
    );
  }
  return <img className={className || 'block-image'} src={url} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />;
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="blocks">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}

function BlockView({ b }: { b: Block }) {
  if (!b || typeof b !== 'object') return null;
  switch (b.type) {
    case 'rich_text':
      return <RichText block={b} />;
    case 'section':
      return (
        <div className="bk-section">
          <div className="bk-section-main">
            {b.text && <TextObj t={b.text} />}
            {b.fields && (
              <div className="bk-fields">
                {b.fields.map((f: El, i: number) => (
                  <div key={i} className="bk-field">
                    <TextObj t={f} />
                  </div>
                ))}
              </div>
            )}
          </div>
          {b.accessory?.type === 'image' && <ExternalImage url={b.accessory.image_url} alt={b.accessory.alt_text} className="bk-accessory-img" />}
          {b.accessory?.type === 'button' && <span className="bk-button">{b.accessory.text?.text}</span>}
        </div>
      );
    case 'header':
      return (
        <div className="bk-header">
          <TextRun text={b.text?.text || ''} />
        </div>
      );
    case 'divider':
      return <hr className="bk-divider" />;
    case 'context':
      return (
        <div className="bk-context">
          {(b.elements || []).map((e: El, i: number) =>
            e.type === 'image' ? (
              <ExternalImage key={i} url={e.image_url} alt={e.alt_text} className="bk-context-img" />
            ) : (
              <span key={i}>
                <TextObj t={e} />
              </span>
            ),
          )}
        </div>
      );
    case 'image':
      return (
        <div className="bk-image">
          {b.title?.text && <div className="bk-image-title">{b.title.text}</div>}
          <ExternalImage url={b.image_url} alt={b.alt_text} />
        </div>
      );
    case 'actions':
      return (
        <div className="bk-actions">
          {(b.elements || []).map((e: El, i: number) =>
            e.url ? (
              <Link key={i} href={e.url}>
                <span className="bk-button">{e.text?.text || 'Open'}</span>
              </Link>
            ) : (
              <span key={i} className="bk-button bk-button-disabled">
                {e.text?.text || e.placeholder?.text || e.type}
              </span>
            ),
          )}
        </div>
      );
    case 'call':
      return <div className="bk-call">📞 Call</div>;
    case 'file':
      return <div className="bk-context">📄 File</div>;
    case 'table':
      return <BKTable b={b} />;
    default:
      if (b.text?.text) return <TextObj t={b.text} />;
      return null;
  }
}

function BKTable({ b }: { b: Block }) {
  const rows: El[][] = b.rows || [];
  return (
    <table className="bk-table">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c: El, j: number) => (
              <td key={j}>{c.type === 'rich_text' ? <RichText block={c} /> : c.text || ''}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** True if blocks contain something worth rendering instead of text. */
export function hasRenderableBlocks(blocks: Block[] | null | undefined): boolean {
  return !!blocks && Array.isArray(blocks) && blocks.some((b) => b && typeof b === 'object' && b.type);
}

export { ExternalImage };
