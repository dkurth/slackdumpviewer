// API types and fetch helpers for the Go server.

export interface Workspace {
  team_id: string;
  team: string;
  url: string;
  user_id: string;
  username: string;
}

export interface User {
  id: string;
  name: string;
  real_name?: string;
  display_name?: string;
  title?: string;
  color?: string;
  email?: string;
  phone?: string;
  tz?: string;
  tz_label?: string;
  is_bot?: boolean;
  is_app?: boolean;
  deleted?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_restricted?: boolean;
  external?: boolean;
  status_text?: string;
  status_emoji?: string;
}

export type ChannelKind = 'public' | 'private' | 'im' | 'mpim';

export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  is_archived?: boolean;
  is_general?: boolean;
  is_shared?: boolean;
  is_member?: boolean;
  created?: number;
  creator?: string;
  topic?: string;
  purpose?: string;
  im_user?: string;
  members?: string[];
  num_members?: number;
  count: number;
  total: number;
  first_ts?: string;
  latest_ts?: string;
}

export interface AliasEntry {
  status: 'suggested' | 'confirmed' | 'rejected';
  maps_to?: string;
  name?: string;
  confidence?: number;
  evidence?: string[];
  messages?: number;
  first_seen?: string;
  last_seen?: string;
}

export interface Bootstrap {
  workspace: Workspace;
  me: string;
  users: User[];
  channels: Channel[];
  avatars: string[];
  custom_emoji: Record<string, string>;
  aliases: Record<string, AliasEntry>;
  in_use: boolean;
  archive_dir: string;
}

export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  pretty_type?: string;
  mode?: string;
  size?: number;
  original_w?: number;
  original_h?: number;
  thumb_360_w?: number;
  thumb_360_h?: number;
  preview?: string;
  lines?: number;
  lines_more?: number;
  is_external?: boolean;
  external_type?: string;
  external_url?: string;
  local?: boolean;
  local_name?: string;
  user?: string;
  created?: number;
  subject?: string;
  plain_text?: string;
}

export interface Reaction {
  name: string;
  count: number;
  users?: string[];
}

export interface AttachmentField {
  title?: string;
  value?: string;
  short?: boolean;
}

export interface Attachment {
  id?: number;
  color?: string;
  fallback?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_subname?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: AttachmentField[];
  footer?: string;
  ts?: string | number;
  image_url?: string;
  image_width?: number;
  image_height?: number;
  thumb_url?: string;
  service_name?: string;
  service_icon?: string;
  from_url?: string;
  original_url?: string;
  blocks?: Block[] | null;
  mrkdwn_in?: string[];
  actions?: { text?: string; type?: string; url?: string }[];
  is_msg_unfurl?: boolean;
  message_blocks?: { message?: { blocks?: Block[] } }[];
  channel_id?: string;
  author_id?: string;
}

// Block Kit / rich text are rendered loosely; keep them as open objects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Block = any;

export interface Message {
  ts: string;
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  reply_count?: number;
  reply_users?: string[];
  reply_users_count?: number;
  latest_reply?: string;
  edited?: { user?: string; ts?: string };
  files?: SlackFile[];
  reactions?: Reaction[];
  attachments?: Attachment[];
  blocks?: Block[] | null;
  pinned_to?: string[];
  hidden?: boolean;
  bot_profile?: { name?: string; id?: string };
  user_profile?: { real_name?: string; display_name?: string; name?: string };
  inviter?: string;
  _ch: string;
  _parent?: string;
  _archived_replies?: number;
}

export interface MessagesResp {
  messages: Message[];
  has_more_before: boolean;
  has_more_after: boolean;
}

export interface ThreadResp {
  parent: Message | null;
  replies: Message[];
}

export interface SearchResp {
  total: number;
  messages: Message[];
  terms: string[];
  warnings?: string[];
}

export interface FileHit {
  id: string;
  channel: string;
  ts: string;
  user?: string;
  name: string;
  title: string;
  filetype?: string;
  mimetype?: string;
  size: number;
  mode?: string;
  thread_ts?: string;
  local: boolean;
}

export interface FileSearchResp {
  total: number;
  files: FileHit[];
  warnings?: string[];
}

export interface Status {
  ready: boolean;
  progress?: { phase: string; done: number; total: number };
  error?: string;
  in_use: boolean;
}

export interface UnknownUser {
  id: string;
  messages: number;
  channels: number;
  first_ts: string;
  last_ts: string;
  dm?: string;
  alias?: AliasEntry;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function getJSON<T>(path: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const u = new URL(path, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
  }
  const r = await fetch(u, { signal });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const j = await r.json();
      msg = j.error || msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(r.status, msg);
  }
  return r.json() as Promise<T>;
}

export async function putJSON<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'slackdumpviewer' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new ApiError(r.status, (await r.text()) || r.statusText);
  return r.json() as Promise<T>;
}

export interface AboutStats {
  archive_dir: string;
  db_path: string;
  db_size: number;
  db_modified: string;
  in_use: boolean;
  cache_dir: string;
  index_size: number;
  sessions: { id: number; created: string; updated: string; mode: string; finished: boolean; files: boolean; avatars: boolean; command: string }[];
  messages: number;
  top_level: number;
  replies: number;
  threads: number;
  claimed_replies: number;
  edited: number;
  pinned: number;
  with_files: number;
  with_links: number;
  bot: number;
  reactions: number;
  first_ts?: string;
  last_ts?: string;
  file_refs: number;
  files: number;
  files_bytes: number;
  local_files: number;
  local_bytes: number;
  conversations: Record<string, number>;
  users: Record<string, number>;
  unknown_users: number;
  avatars: number;
  custom_emoji: number;
  by_year: { year: string; count: number }[];
  top_channels: { id: string; count: number }[];
  top_posters: { id: string; count: number }[];
}
export interface AboutResp {
  stats: AboutStats;
  workspace: Workspace;
  me: string;
  aliases: Record<string, number>;
  aliases_path: string;
}

export const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

export const api = {
  status: () => getJSON<Status>('/api/status'),
  bootstrap: () => getJSON<Bootstrap>('/api/bootstrap'),
  messages: (channel: string, p: { before?: string; after?: string; around?: string; limit?: number }, signal?: AbortSignal) =>
    getJSON<MessagesResp>('/api/messages', { channel, ...p }, signal),
  thread: (channel: string, ts: string, signal?: AbortSignal) => getJSON<ThreadResp>('/api/thread', { channel, ts }, signal),
  lookup: (channel: string, ts: string) => getJSON<{ found: boolean; top?: boolean; thread_ts?: string }>('/api/message', { channel, ts }),
  conversation: (channel: string) =>
    getJSON<{ channel: Channel; pins: Message[]; file_count: number }>('/api/conversation', { channel }),
  conversationFiles: (channel: string, offset = 0) => getJSON<FileSearchResp>('/api/conversation/files', { channel, offset }),
  search: (q: string, sort: string, offset: number, signal?: AbortSignal) =>
    getJSON<SearchResp>('/api/search', { q, sort, offset, tz, limit: 20 }, signal),
  searchFiles: (q: string, sort: string, offset: number, signal?: AbortSignal) =>
    getJSON<FileSearchResp>('/api/search/files', { q, sort, offset, tz, limit: 30 }, signal),
  aliasesInfo: () => getJSON<{ path: string }>('/api/aliases'),
  about: () => getJSON<AboutResp>('/api/about'),
  unknownUsers: () => getJSON<{ users: UnknownUser[] }>('/api/unknown-users'),
  setAlias: (id: string, e: Partial<AliasEntry>) => putJSON<{ ok: boolean; alias: AliasEntry }>(`/api/aliases/${id}`, e),
};

export const fileURL = (f: { id: string; name?: string; local_name?: string }, download = false) =>
  `/files/${f.id}/${encodeURIComponent(f.local_name || f.name || 'file')}${download ? '?download=1' : ''}`;
export const thumbURL = (id: string, w: number) => `/thumbs/${id}?w=${w}`;
export const avatarURL = (id: string, s: number) => `/avatars/${id}?s=${s}`;
