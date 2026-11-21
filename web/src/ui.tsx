import { createContext, useContext } from 'react';

// Actions any component can trigger; provided by App.
export interface UI {
  openProfile: (userId: string, anchor?: HTMLElement | null) => void;
  openChannel: (channelId: string, ts?: string) => void;
  openThread: (channelId: string, parentTs: string, replyTs?: string) => void;
  openLightbox: (files: { id: string; name?: string; local_name?: string; title?: string; mimetype?: string }[], index: number) => void;
  search: (q: string) => void;
  toast: (msg: string) => void;
}

export const UICtx = createContext<UI | null>(null);

export function useUI(): UI {
  const u = useContext(UICtx);
  if (!u) throw new Error('UI not ready');
  return u;
}

// Search terms to highlight inside rendered messages.
export const HighlightCtx = createContext<string[]>([]);
export const useHighlight = () => useContext(HighlightCtx);
