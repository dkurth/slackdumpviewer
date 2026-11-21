export const tsDate = (ts: string | number | undefined): Date => new Date(parseFloat(String(ts ?? 0)) * 1000);

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function formatTime(ts: string | number, clock24 = false): string {
  return tsDate(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: !clock24 });
}

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today", "Yesterday", "Tuesday, March 4th", "Tuesday, March 4th, 2023" */
export function formatDay(d: Date, now = new Date()): string {
  if (sameDay(d, now)) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Yesterday';
  const wd = d.toLocaleDateString(undefined, { weekday: 'long' });
  const mo = d.toLocaleDateString(undefined, { month: 'long' });
  const base = `${wd}, ${mo} ${ordinal(d.getDate())}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/** Full date + time, for tooltips. */
export function formatFull(ts: string | number, clock24 = false): string {
  const d = tsDate(ts);
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} at ${d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: !clock24,
  })}`;
}

export function formatShortDate(ts: string | number): string {
  const d = tsDate(ts);
  const now = new Date();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function relative(ts: string | number, now = Date.now()): string {
  const s = (now - tsDate(ts).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hours ago`;
  if (s < 86400 * 2) return 'yesterday';
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))} months ago`;
  return `${Math.floor(s / (86400 * 365))} years ago`;
}

export function formatSize(n?: number): string {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const modKey = isMac ? '⌘' : 'Ctrl';
export const altKey = isMac ? '⌥' : 'Alt';

export function isMod(e: KeyboardEvent | React.KeyboardEvent) {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** Ts string → start-of-day key (local). */
export function dayKey(ts: string): string {
  const d = tsDate(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function copyText(s: string) {
  navigator.clipboard?.writeText(s).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = s;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}

/** Fuzzy score for quick switcher: higher is better, -1 = no match. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - t.length;
  const wordStart = t.split(/[\s\-_.,]+/).some((w) => w.startsWith(q));
  if (wordStart) return 600 - t.length;
  const i = t.indexOf(q);
  if (i >= 0) return 400 - i - t.length / 10;
  // subsequence
  let qi = 0;
  let gaps = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
    else if (qi > 0) gaps++;
  }
  return qi === q.length ? 200 - gaps - t.length / 10 : -1;
}
