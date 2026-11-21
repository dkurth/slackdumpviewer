import emojiData from './emoji-data.json';
import { useStore } from './store';

const standard = emojiData as Record<string, string>;

export function emojiChar(name: string): string | undefined {
  return standard[name] ?? standard[name.replace(/::skin-tone-\d$/, '')];
}

function resolveCustom(custom: Record<string, string>, name: string): string | undefined {
  let n = name;
  for (let i = 0; i < 4; i++) {
    const v = custom[n];
    if (!v) return undefined;
    if (!v.startsWith('alias:')) return v;
    n = v.slice(6);
    const std = emojiChar(n);
    if (std) return 'std:' + std;
  }
  return undefined;
}

/** Renders :name: as a Unicode emoji, a custom emoji image, or a text pill. */
export function Emoji({ name, unicode, size }: { name: string; unicode?: string; size?: 'big' | 'reaction' }) {
  const { boot } = useStore();
  const clean = name.replace(/^:|:$/g, '');
  let ch = emojiChar(clean);
  if (!ch && unicode) {
    try {
      ch = String.fromCodePoint(...unicode.split('-').map((h) => parseInt(h, 16)));
    } catch {
      /* ignore */
    }
  }
  const cls = 'emoji' + (size ? ' emoji-' + size : '');
  if (ch) {
    return (
      <span className={cls} title={`:${clean}:`} role="img" aria-label={clean}>
        {ch}
      </span>
    );
  }
  const custom = resolveCustom(boot.custom_emoji, clean);
  if (custom?.startsWith('std:')) {
    return (
      <span className={cls} title={`:${clean}:`} role="img" aria-label={clean}>
        {custom.slice(4)}
      </span>
    );
  }
  if (custom) {
    return <img className={cls + ' emoji-img'} src={custom} alt={`:${clean}:`} title={`:${clean}:`} loading="lazy" />;
  }
  return (
    <span className="emoji-missing" title={`Custom emoji :${clean}: (not in the archive)`}>
      :{clean}:
    </span>
  );
}
