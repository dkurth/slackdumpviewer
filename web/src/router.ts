// Tiny history-API router.
//   /client/:ch                    conversation, newest messages
//   /client/:ch/:ts                conversation around a message (highlighted)
//   /client/:ch/thread/:parent[/:reply]  conversation + thread pane
//   /search?q=&tab=&sort=          search results
//   /archives/:ch/p1234567890123456[?thread_ts=..]  Slack permalink → rewritten
//   /aliases                       unknown users / alias review (/unknown-users still works)
//   /about                         about this archive
import { useEffect, useState } from 'react';

export type Route =
  | { kind: 'home' }
  | { kind: 'channel'; ch: string; ts?: string; thread?: string; reply?: string }
  | { kind: 'search'; q: string; tab: string; sort: string }
  | { kind: 'unknown-users' }
  | { kind: 'about' };

export function slackTS(p: string): string {
  // p1691774440143419 -> 1691774440.143419
  const d = p.replace(/^p/, '');
  if (d.includes('.')) return d;
  return d.slice(0, d.length - 6) + '.' + d.slice(-6);
}

export function parseRoute(loc: Location | URL = window.location): Route {
  const parts = loc.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(loc.search);
  if (parts[0] === 'client' && parts[1]) {
    if (parts[2] === 'thread' && parts[3]) return { kind: 'channel', ch: parts[1], thread: parts[3], reply: parts[4] };
    return { kind: 'channel', ch: parts[1], ts: parts[2] };
  }
  if (parts[0] === 'archives' && parts[1]) {
    const ts = parts[2] ? slackTS(parts[2]) : undefined;
    const thread = q.get('thread_ts') || undefined;
    if (thread && ts && thread !== ts) return { kind: 'channel', ch: parts[1], thread, reply: ts };
    return { kind: 'channel', ch: parts[1], ts };
  }
  if (parts[0] === 'search') return { kind: 'search', q: q.get('q') || '', tab: q.get('tab') || 'messages', sort: q.get('sort') || 'relevance' };
  if (parts[0] === 'unknown-users' || parts[0] === 'aliases') return { kind: 'unknown-users' };
  if (parts[0] === 'about') return { kind: 'about' };
  return { kind: 'home' };
}

export function routeURL(r: Route): string {
  switch (r.kind) {
    case 'home':
      return '/';
    case 'channel':
      if (r.thread) return `/client/${r.ch}/thread/${r.thread}${r.reply ? '/' + r.reply : ''}`;
      return `/client/${r.ch}${r.ts ? '/' + r.ts : ''}`;
    case 'search': {
      const p = new URLSearchParams({ q: r.q });
      if (r.tab && r.tab !== 'messages') p.set('tab', r.tab);
      if (r.sort && r.sort !== 'relevance') p.set('sort', r.sort);
      return `/search?${p}`;
    }
    case 'unknown-users':
      return '/aliases';
    case 'about':
      return '/about';
  }
}

const listeners = new Set<() => void>();

export function navigate(r: Route | string, replace = false) {
  const url = typeof r === 'string' ? r : routeURL(r);
  if (url === window.location.pathname + window.location.search) return;
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  listeners.forEach((l) => l());
}

window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute());
  useEffect(() => {
    const l = () => setRoute(parseRoute());
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return route;
}

/** Map a Slack URL (https://team.slack.com/archives/C…/p…) to an in-app path, or null. */
export function internalPath(href: string, teamHost: string): string | null {
  try {
    const u = new URL(href);
    if (!u.host.endsWith('slack.com')) return null;
    if (teamHost && u.host !== teamHost && !u.host.startsWith('app.')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] === 'archives' && parts[1]) return u.pathname + u.search;
    return null;
  } catch {
    return null;
  }
}
