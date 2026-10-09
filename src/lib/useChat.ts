'use client';

import { useCallback, useRef, useState } from 'react';
import type { ChatMessage } from './types';
import type { Turn } from './chat/conversations';

interface Page { conversationId: string; revision: string; turns: Turn[]; more: boolean }
function messagesFor(turns: Turn[]): ChatMessage[] {
  return turns.flatMap((t) => [
    { id: `${t.id}-user`, sender: 'user' as const, text: t.question, timestamp: new Date(t.created_at) },
    { id: `${t.id}-bot`, sender: 'bot' as const, text: t.response?.answer ?? '', timestamp: new Date(t.created_at),
      rows: t.response?.rows, sources: t.response?.sources, lang: t.response?.lang, route: t.response?.route,
      error: t.response?.error, loading: !t.response },
  ]);
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const session = useRef({ id: '', revision: '0', first: '', epoch: 0 });
  const busy = useRef(false);
  const fetching = useRef(false);

  const load = useCallback(async (earlier = false) => {
    if (fetching.current || busy.current) return;
    fetching.current = true;
    setLoading(true);
    setError(null);
    const epoch = session.current.epoch;
    try {
      const res = await fetch(`/api/chat${earlier && session.current.first ? `?before=${session.current.first}&conversationId=${session.current.id}` : ''}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load the conversation.');
      if (epoch !== session.current.epoch) return;
      const p = data as Page;
      const append = earlier && p.conversationId === session.current.id;
      session.current = { id: p.conversationId, revision: append ? session.current.revision : p.revision, first: p.turns[0]?.id ?? session.current.first, epoch };
      setMessages((m) => append ? [...messagesFor(p.turns), ...m] : messagesFor(p.turns));
      setReady(true);
      setMore(p.more);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load the conversation.'); setReady(false); }
    finally { fetching.current = false; setLoading(false); }
  }, []);

  const ask = async (_role: unknown, question: string): Promise<{ text: string; lang: 'en' | 'hi' | 'gu' } | null> => {
    if (!question.trim() || !ready || busy.current || fetching.current || messages.some((m) => m.loading)) return null;
    busy.current = true;
    setError(null);
    const current = { ...session.current };
    const requestId = crypto.randomUUID();
    const user: ChatMessage = { id: `${requestId}-user`, sender: 'user', text: question, timestamp: new Date() };
    setMessages((m) => [...m, user, { id: requestId, sender: 'bot', text: '', timestamp: new Date(), loading: true }]);
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, conversationId: current.id, revision: current.revision, requestId }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not answer. Please try again.');
      if (current.epoch !== session.current.epoch || current.id !== data.conversationId) return null;
      session.current.revision = data.revision;
      const msg: ChatMessage = { id: `${data.revision}-bot`, sender: 'bot', text: data.answer, rows: data.rows, route: data.route, sources: data.sources, lang: data.lang, error: data.error, timestamp: new Date() };
      setMessages((m) => [...m.filter((x) => x.id !== requestId), msg]);
      return { text: msg.text, lang: msg.lang ?? 'en' };
    } catch (err) {
      if (current.epoch === session.current.epoch) {
        setMessages((m) => m.filter((x) => x.id !== requestId));
        setError(err instanceof Error ? err.message : 'Connection interrupted. Reload the chat to check whether your message was saved.');
        setReady(false); // resync before another question; never silently lose server context
      }
      return null;
    } finally { busy.current = false; }
  };

  const clear = async () => {
    if (busy.current || fetching.current || !session.current.id) return;
    busy.current = true;
    setLoading(true);
    try {
      const res = await fetch('/api/chat', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: session.current.id }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not clear the conversation.');
      session.current = { id: data.conversationId, revision: '0', first: '', epoch: session.current.epoch + 1 };
      setMessages([]); setMore(false); setError(null); setReady(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not clear the conversation.'); }
    finally { busy.current = false; setLoading(false); }
  };
  return { messages, ask, clearChat: clear, loadChat: load, chatReady: ready, chatLoading: loading, chatError: error, chatMore: more };
}
