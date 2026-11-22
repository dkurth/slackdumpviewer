import type { Attachment } from './api';
import { Blocks, ExternalImage, hasRenderableBlocks } from './blocks';
import { Link, Mrkdwn } from './mrkdwn';
import { formatShortDate } from './util';

function colorOf(c?: string) {
  if (!c) return undefined;
  if (c === 'good') return '#2eb67d';
  if (c === 'warning') return '#ecb22e';
  if (c === 'danger') return '#e01e5a';
  return c.startsWith('#') ? c : '#' + c;
}

export function AttachmentView({ a }: { a: Attachment }) {
  const isUnfurl = !!(a.from_url || a.original_url) && !a.fields?.length;
  const msgBlocks = a.message_blocks?.flatMap((mb) => mb.message?.blocks || []) || [];
  const title = a.title ? a.title_link ? <Link href={a.title_link}>{a.title}</Link> : <Mrkdwn text={a.title} className="inline" /> : null;
  const body =
    hasRenderableBlocks(a.blocks) ? (
      <Blocks blocks={a.blocks!} />
    ) : msgBlocks.length ? (
      <Blocks blocks={msgBlocks} />
    ) : a.text ? (
      <Mrkdwn text={a.text} />
    ) : !a.title && !a.fields?.length && a.fallback ? (
      <Mrkdwn text={a.fallback} />
    ) : null;
  return (
    <div className="attachment-wrap">
      {a.pretext && <Mrkdwn text={a.pretext} className="att-pretext" />}
      <div className={'attachment' + (isUnfurl ? ' unfurl' : '')} style={{ borderLeftColor: colorOf(a.color) }}>
        <div className="att-main">
          {isUnfurl && a.service_name && <div className="att-service">{a.service_name}</div>}
          {a.author_name && (
            <div className="att-author">
              {a.author_link ? <Link href={a.author_link}>{a.author_name}</Link> : a.author_name}
              {a.author_subname && <span className="att-author-sub"> {a.author_subname}</span>}
            </div>
          )}
          {title && <div className="att-title">{title}</div>}
          {body && <div className="att-text">{body}</div>}
          {a.fields && a.fields.length > 0 && (
            <div className="att-fields">
              {a.fields.map((f, i) => (
                <div key={i} className={'att-field' + (f.short ? ' short' : '')}>
                  {f.title && <div className="att-field-title">{f.title}</div>}
                  {f.value && <Mrkdwn text={f.value} />}
                </div>
              ))}
            </div>
          )}
          {a.image_url && <ExternalImage url={a.image_url} alt={a.title || 'image'} className="att-image" />}
          {a.actions && a.actions.length > 0 && (
            <div className="bk-actions">
              {a.actions.map((x, i) =>
                x.url ? (
                  <Link key={i} href={x.url}>
                    <span className="bk-button">{x.text}</span>
                  </Link>
                ) : (
                  <span key={i} className="bk-button bk-button-disabled">
                    {x.text}
                  </span>
                ),
              )}
            </div>
          )}
          {(a.footer || a.ts) && (
            <div className="att-footer">
              {a.footer && <Mrkdwn text={a.footer} className="inline" />}
              {a.footer && a.ts ? ' | ' : ''}
              {a.ts ? formatShortDate(a.ts) : ''}
            </div>
          )}
        </div>
        {a.thumb_url && !a.image_url && <ExternalImage url={a.thumb_url} alt="" className="att-thumb" />}
      </div>
    </div>
  );
}

export function Attachments({ list }: { list: Attachment[] }) {
  return (
    <div className="attachments">
      {list.map((a, i) => (
        <AttachmentView key={i} a={a} />
      ))}
    </div>
  );
}
