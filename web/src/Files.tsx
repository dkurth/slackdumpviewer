import { Download, ExternalLink, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, File as FileIcon, Mail, X, ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import type { SlackFile } from './api';
import { fileURL, thumbURL } from './api';
import { useUI } from './ui';
import { formatSize } from './util';

const browserImage = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;

export function isInlineImage(f: SlackFile) {
  return !!f.local && browserImage.test(f.mimetype || '');
}

function imageBox(f: SlackFile, maxW = 360, maxH = 360) {
  const w = f.original_w || f.thumb_360_w || 360;
  const h = f.original_h || f.thumb_360_h || 240;
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(40, Math.round(w * scale)), height: Math.max(30, Math.round(h * scale)) };
}

function iconFor(f: SlackFile) {
  const m = f.mimetype || '';
  const t = (f.filetype || '').toLowerCase();
  if (f.mode === 'email') return <Mail />;
  if (m.startsWith('image/')) return <FileImage />;
  if (m.startsWith('video/')) return <FileVideo />;
  if (m.startsWith('audio/')) return <FileAudio />;
  if (/sheet|excel|csv/.test(m) || ['xlsx', 'xls', 'csv', 'gsheet', 'numbers'].includes(t)) return <FileSpreadsheet />;
  if (/zip|tar|compressed|gzip/.test(m)) return <FileArchive />;
  if (m.startsWith('text/') || ['json', 'xml', 'sql', 'javascript', 'python', 'go', 'shell'].includes(t)) return <FileCode />;
  if (/pdf|word|document|presentation/.test(m)) return <FileText />;
  return <FileIcon />;
}

export function FileCard({ f, note }: { f: SlackFile; note?: string }) {
  const href = f.local ? fileURL(f) : f.external_url;
  const sub = note || [f.pretty_type || f.filetype?.toUpperCase(), formatSize(f.size)].filter(Boolean).join(' · ');
  return (
    <div className={'file-card' + (f.local || f.external_url ? '' : ' file-card-missing')}>
      <div className="file-card-icon">{iconFor(f)}</div>
      <div className="file-card-body">
        {href ? (
          <a className="file-card-name" href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            {f.title || f.name}
          </a>
        ) : (
          <span className="file-card-name">{f.title || f.name}</span>
        )}
        <div className="file-card-sub">{sub}</div>
      </div>
      {f.local && (
        <a className="icon-btn" href={fileURL(f, true)} title="Download" onClick={(e) => e.stopPropagation()}>
          <Download size={16} />
        </a>
      )}
      {!f.local && f.external_url && (
        <a className="icon-btn" href={f.external_url} target="_blank" rel="noopener noreferrer" title="Open">
          <ExternalLink size={16} />
        </a>
      )}
    </div>
  );
}

const langFor: Record<string, string> = {
  javascript: 'javascript', js: 'javascript', typescript: 'typescript', python: 'python', go: 'go', sql: 'sql', shell: 'bash',
  bash: 'bash', json: 'json', xml: 'xml', html: 'xml', css: 'css', php: 'php', ruby: 'ruby', java: 'java', csharp: 'csharp',
  c: 'c', cpp: 'cpp', yaml: 'yaml', yml: 'yaml', markdown: 'markdown', diff: 'diff', kotlin: 'kotlin', swift: 'swift', rust: 'rust',
};

function Snippet({ f }: { f: SlackFile }) {
  const [full, setFull] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const text = full ?? f.preview ?? '';
  const lang = langFor[(f.filetype || '').toLowerCase()];
  const html = (() => {
    try {
      return lang ? hljs.highlight(text, { language: lang }).value : null;
    } catch {
      return null;
    }
  })();
  const more = !full && f.local && ((f.lines_more || 0) > 0 || (f.size || 0) > (f.preview?.length || 0) + 10);
  const load = () => {
    if (!f.local) return;
    fetch(fileURL(f) + '?raw=1')
      .then((r) => r.text())
      .then((t) => {
        setFull(t.length > 500_000 ? t.slice(0, 500_000) + '\n…' : t);
        setExpanded(true);
      });
  };
  return (
    <div className="snippet">
      <div className="snippet-head">
        <span className="snippet-name">{f.title || f.name}</span>
        <span className="snippet-type">{f.pretty_type || f.filetype}</span>
        {f.local && (
          <a className="icon-btn" href={fileURL(f, true)} title="Download">
            <Download size={14} />
          </a>
        )}
      </div>
      {text ? (
        html ? (
          <pre className={'code-block snippet-body hljs' + (expanded ? ' expanded' : '')} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className={'code-block snippet-body' + (expanded ? ' expanded' : '')}>{text}</pre>
        )
      ) : (
        <div className="snippet-empty">No preview</div>
      )}
      {more && (
        <button className="snippet-more" onClick={load}>
          Show full file{f.lines ? ` (${f.lines} lines)` : ''}
        </button>
      )}
    </div>
  );
}

export function FileView({ f, all, idx }: { f: SlackFile; all: SlackFile[]; idx: number }) {
  const ui = useUI();
  if (f.mode === 'tombstone') return <div className="file-tombstone">This file was deleted.</div>;
  if (f.mode === 'snippet' || f.mode === 'post' || (f.mode === 'hosted' && (f.mimetype || '').startsWith('text/plain') && f.preview)) {
    return <Snippet f={f} />;
  }
  if (f.mode === 'email') {
    return (
      <div className="email-card">
        <div className="email-subject">
          <Mail size={14} /> {f.subject || f.title}
        </div>
        <div className="email-body">{(f.plain_text || f.preview || '').slice(0, 800)}</div>
      </div>
    );
  }
  if (f.mode === 'quip' || f.mode === 'canvas' || f.filetype === 'quip' || f.mode === 'list' || f.filetype === 'list') {
    return <FileCard f={f} note={(f.mode === 'list' ? 'Slack list' : 'Canvas') + ' · not viewable in the archive'} />;
  }
  const m = f.mimetype || '';
  if (isInlineImage(f)) {
    const box = imageBox(f);
    const images = all.filter(isInlineImage);
    const i = images.indexOf(f);
    return (
      <button
        className="file-image"
        style={box}
        onClick={(e) => {
          e.stopPropagation();
          ui.openLightbox(images, Math.max(0, i));
        }}
        title={f.title || f.name}
      >
        <img src={thumbURL(f.id, box.width > 360 ? 1440 : 720)} alt={f.title || f.name} loading="lazy" decoding="async" width={box.width} height={box.height} />
      </button>
    );
  }
  if (f.local && m.startsWith('video/') && /mp4|webm|ogg|quicktime/.test(m)) {
    const box = imageBox(f, 480, 360);
    return (
      <div className="file-video">
        <video controls preload="metadata" src={fileURL(f)} style={{ maxWidth: 480, width: box.width < 200 ? 480 : box.width }} />
        <div className="file-caption">{f.title || f.name}</div>
      </div>
    );
  }
  if (f.local && m.startsWith('audio/')) {
    return (
      <div className="file-audio">
        <div className="file-caption">{f.title || f.name}</div>
        <audio controls preload="none" src={fileURL(f)} />
      </div>
    );
  }
  if (!f.local && f.mode !== 'external') return <FileCard f={f} note="Not downloaded in this archive" />;
  void idx;
  return <FileCard f={f} />;
}

export function Files({ files }: { files: SlackFile[] }) {
  return (
    <div className="files">
      {files.map((f, i) => (
        <FileView key={f.id + i} f={f} all={files} idx={i} />
      ))}
    </div>
  );
}

export function Lightbox({ files, index, onClose }: { files: { id: string; name?: string; local_name?: string; title?: string }[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const f = files[i];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      else if (e.key === 'ArrowRight') setI((x) => Math.min(files.length - 1, x + 1));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [files.length, onClose]);
  if (!f) return null;
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Image viewer">
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{f.title || f.name}</span>
        {files.length > 1 && (
          <span className="lightbox-count">
            {i + 1} of {files.length}
          </span>
        )}
        <a className="icon-btn light" href={fileURL(f, true)} title="Download">
          <Download size={18} />
        </a>
        <a className="icon-btn light" href={fileURL(f)} target="_blank" rel="noopener noreferrer" title="Open original">
          <ExternalLink size={18} />
        </a>
        <button className="icon-btn light" onClick={onClose} title="Close (Esc)">
          <X size={20} />
        </button>
      </div>
      {i > 0 && (
        <button className="lightbox-nav left" onClick={(e) => (e.stopPropagation(), setI(i - 1))} aria-label="Previous">
          <ChevronLeft size={32} />
        </button>
      )}
      <img className="lightbox-img" src={fileURL(f)} alt={f.title || f.name} onClick={(e) => e.stopPropagation()} />
      {i < files.length - 1 && (
        <button className="lightbox-nav right" onClick={(e) => (e.stopPropagation(), setI(i + 1))} aria-label="Next">
          <ChevronRight size={32} />
        </button>
      )}
    </div>
  );
}
