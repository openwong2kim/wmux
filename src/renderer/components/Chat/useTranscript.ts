import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatBridgeApi, TranscriptAppendData, TranscriptPage, TranscriptStatus, TurnEvent } from '../../../shared/transcript/turnEvents';
import { mergeTranscriptEvents } from './transcriptState';

interface State {
  events: TurnEvent[];
  status: TranscriptStatus;
  loading: boolean;
  loadingEarlier: boolean;
  hasMore: boolean;
  blocked: boolean;
  error: boolean;
  lastSyncedAt: number | null;
}
const initial: State = { events: [], status: { available: false, reason: 'loading' }, loading: true,
  loadingEarlier: false, hasMore: false, blocked: true, error: false, lastSyncedAt: null };

/** Only visible chat surfaces own transcript subscriptions. The hidden terminal
 * remains mounted independently; workspace switches release these watchers. */
export function useTranscript(ptyId: string, active: boolean, api: ChatBridgeApi | undefined = window.electronAPI?.chat) {
  const [state, setState] = useState<State>(initial);
  const [revision, setRevision] = useState(0);
  const pageRef = useRef<TranscriptPage | null>(null);
  const generation = useRef(0);
  const ownerPty = useRef(ptyId);
  const historyVersion = useRef(0);
  const earlierPending = useRef(false);
  const retry = useCallback(() => setRevision((n) => n + 1), []);

  useEffect(() => {
    const epoch = ++generation.current;
    pageRef.current = null;
    historyVersion.current++;
    earlierPending.current = false;
    const samePty = ownerPty.current === ptyId;
    ownerPty.current = ptyId;
    setState((s) => samePty ? { ...s, loading: true, error: false, blocked: true } : initial);
    if (!active || !api) {
      setState({ ...initial, loading: false, status: { available: false, reason: 'unavailable' } });
      return;
    }
    let alive = true;
    let loading = false;
    let gateVersion = 0;
    let connected = true;
    let connectionVersion = 0;
    let rerun = false;
    let subscribed = false;
    let lastSeq: number | undefined;
    let sessionId: string | undefined;
    let queued: TranscriptAppendData[] = [];
    const current = () => alive && generation.current === epoch;
    const refresh = async (replace = false) => {
      if (!connected) return;
      if (loading) { rerun ||= replace; return; }
      loading = true;
      const gateAtStart = gateVersion;
      const connectionAtStart = connectionVersion;
      const fresh = () => current() && connected && connectionAtStart === connectionVersion;
      try {
        const [status, gates] = await Promise.all([api.status(ptyId), api.openGates()]);
        if (!fresh()) return;
        const changed = sessionId !== status.agentSessionId;
        if (!status.available) {
          // A lost connection must not erase already-read history or its draft.
          setState((s) => (status.reason === 'unavailable' || status.reason === 'unreadable') &&
            (!status.agentSessionId || status.agentSessionId === s.status.agentSessionId) &&
            (!status.transcriptBasename || !s.status.transcriptBasename || status.transcriptBasename === s.status.transcriptBasename)
            ? { ...s, loading: false, error: status.reason === 'unavailable' || s.events.length > 0, blocked: true,
              status: { ...status, agentSessionId: s.status.agentSessionId, transcriptBasename: status.transcriptBasename ?? s.status.transcriptBasename } }
            : { ...initial, loading: false, status, blocked: true });
          return;
        }
        sessionId = status.agentSessionId;
        if (!subscribed) {
          const sub = await api.subscribe(ptyId);
          subscribed = true; // balance even failed registrations in main
          if (!current()) { void api.unsubscribe(ptyId).catch(() => undefined); return; }
          if (!fresh()) return;
          if (!sub.ok) {
            subscribed = false;
            await api.unsubscribe(ptyId);
            throw new Error('subscribe unavailable');
          }
        }
        const page = await api.snapshot(ptyId);
        if (!fresh()) return;
        if (!page) throw new Error('snapshot unavailable');
        const previous = pageRef.current;
        const reset = replace || changed || !previous || page.cursor.fileSize < previous.cursor.tailOffset;
        if (reset) historyVersion.current++;
        pageRef.current = reset ? page : { ...page, hasMore: previous.hasMore,
          cursor: { ...page.cursor, headOffset: previous.cursor.headOffset } };
        setState((s) => ({ ...s, status, loading: false, error: false, lastSyncedAt: Date.now(),
          blocked: gateAtStart === gateVersion ? gates === null || gates.includes(ptyId) : s.blocked,
          events: reset ? page.events : mergeTranscriptEvents(s.events, page.events),
          hasMore: pageRef.current!.hasMore,
        }));
      } catch {
        if (fresh()) setState((s) => ({ ...s, loading: false, error: true, blocked: true }));
      } finally {
        loading = false;
        if (current()) {
          const pending = queued;
          queued = [];
          for (const delta of pending) apply(delta);
          if (rerun) { rerun = false; void refresh(true); }
        }
      }
    };
    const apply = (delta: TranscriptAppendData) => {
      if (!current() || !connected) return;
      if (loading) { queued.push(delta); return; }
      if (delta.reset || (lastSeq !== undefined && delta.seq > lastSeq + 1)) {
        lastSeq = delta.seq;
        historyVersion.current++;
        pageRef.current = null;
        setState((s) => ({ ...s, events: [], loading: true, blocked: true }));
        void refresh(true);
        return;
      }
      if (lastSeq !== undefined && delta.seq <= lastSeq) return;
      lastSeq = delta.seq;
      const page = pageRef.current;
      if (!page || delta.cursor.tailOffset <= page.cursor.tailOffset) return;
      pageRef.current = { ...page, cursor: { ...delta.cursor, headOffset: page.cursor.headOffset } };
      setState((s) => ({ ...s, lastSyncedAt: Date.now(), events: mergeTranscriptEvents(s.events, delta.events) }));
    };
    const offAppend = api.onAppend((id, delta) => { if (id === ptyId) apply(delta); });
    const offGate = api.onGate((id, gate) => {
      if (id === ptyId && current()) {
        gateVersion++;
        setState((s) => ({ ...s, blocked: gate.kind === 'open' }));
      }
    });
    const offDisconnected = window.electronAPI?.daemon?.onDisconnected?.(() => {
      gateVersion++;
      connected = false; connectionVersion++; historyVersion.current++; queued = [];
      if (current()) setState((s) => ({ ...s, error: true, blocked: true }));
    });
    const offConnected = window.electronAPI?.daemon?.onConnected?.(() => {
      connected = true;
      subscribed = false;
      lastSeq = undefined;
      void refresh(true);
    });
    void refresh(true);
    // Status can become available after SessionStart; also repairs dropped
    // append subscriptions and a missed permission transition on reconnect.
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      generation.current++;
      clearInterval(timer);
      offAppend(); offGate(); offDisconnected?.(); offConnected?.();
      if (subscribed) void api.unsubscribe(ptyId).catch(() => undefined);
    };
  }, [ptyId, active, api, revision]);

  const loadEarlier = useCallback(async () => {
    const page = pageRef.current;
    if (!api || !page?.hasMore || earlierPending.current) return;
    const epoch = generation.current;
    const history = historyVersion.current;
    earlierPending.current = true;
    setState((s) => ({ ...s, loadingEarlier: true }));
    try {
      const older = await api.snapshot(ptyId, page.cursor.headOffset);
      if (epoch !== generation.current || history !== historyVersion.current || pageRef.current?.cursor.headOffset !== page.cursor.headOffset) return;
      if (!older) throw new Error('earlier unavailable');
      pageRef.current = { ...pageRef.current, hasMore: older.hasMore,
        cursor: { ...pageRef.current.cursor, headOffset: older.cursor.headOffset } };
      setState((s) => ({ ...s, events: mergeTranscriptEvents(s.events, older.events, true), hasMore: older.hasMore }));
    } catch { if (epoch === generation.current) setState((s) => ({ ...s, error: true })); }
    finally {
      if (epoch === generation.current) { earlierPending.current = false; setState((s) => ({ ...s, loadingEarlier: false })); }
    }
  }, [api, ptyId]);
  return { ...state, retry, loadEarlier };
}
