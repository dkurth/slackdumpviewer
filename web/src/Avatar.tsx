import { Bot, User as UserIcon } from 'lucide-react';
import { avatarURL } from './api';
import type { Person } from './store';

export function Avatar({ p, size = 36, onClick }: { p: Person; size?: number; onClick?: (e: React.MouseEvent<HTMLElement>) => void }) {
  const style = { width: size, height: size, borderRadius: Math.max(4, Math.round(size * 0.22)) };
  const cls = 'avatar' + (onClick ? ' clickable' : '');
  if (p.avatarId) {
    return (
      <img
        className={cls}
        style={style}
        src={avatarURL(p.avatarId, size * 2 <= 72 ? 72 : size * 2 <= 128 ? 128 : 256)}
        alt=""
        loading="lazy"
        onClick={onClick}
        draggable={false}
      />
    );
  }
  if (p.unknown && !p.bot) {
    return (
      <span className={cls + ' avatar-unknown'} style={style} onClick={onClick}>
        <UserIcon size={size * 0.6} />
      </span>
    );
  }
  if (p.bot && !p.user) {
    return (
      <span className={cls + ' avatar-bot'} style={{ ...style, background: p.color }} onClick={onClick}>
        <Bot size={size * 0.6} />
      </span>
    );
  }
  const initials = p.name
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <span className={cls + ' avatar-initials'} style={{ ...style, background: p.color, fontSize: size * 0.4 }} onClick={onClick}>
      {initials || '?'}
    </span>
  );
}
