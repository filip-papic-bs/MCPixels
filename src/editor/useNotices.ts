import { useEffect, useRef, useState } from "react";
import { NOTICE_FADE, NOTICE_HOLD, NOTICE_LOG_LIMIT } from "./constants.tsx";
import type { Notice, NoticeLogEntry, NoticeMeta } from "./constants.tsx";

export function useNotices() {
  const [activity, setActivity] = useState("Canvas ready. Pick a color and draw.");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [noticeLog, setNoticeLog] = useState<NoticeLogEntry[]>([]);
  const [noticeLimit, setNoticeLimit] = useState(() => (window.matchMedia("(max-width: 720px)").matches ? 3 : 5));

  const noticesRef = useRef<Notice[]>(notices);
  const noticeLogRef = useRef<NoticeLogEntry[]>(noticeLog);
  const noticeLimitRef = useRef(noticeLimit);
  const noticeTimersRef = useRef(new Map<number, { hide: number; drop: number }>());
  const noticeIdRef = useRef(0);
  const mountedRef = useRef(true);

  noticeLimitRef.current = noticeLimit;

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => setNoticeLimit(query.matches ? 3 : 5);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const timers = noticeTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const { hide, drop } of timers.values()) {
        window.clearTimeout(hide);
        window.clearTimeout(drop);
      }
      timers.clear();
    };
  }, []);

  const applyNotices = (next: Notice[]) => {
    noticesRef.current = next;
    if (mountedRef.current) setNotices(next);
  };

  const appendLog = (id: number, text: string, meta?: NoticeMeta) => {
    const log = noticeLogRef.current;
    const last = log.at(-1);
    const next =
      last && last.text === text
        ? [...log.slice(0, -1), { ...last, count: last.count + 1, at: Date.now(), ...meta }]
        : [...log, { id, text, count: 1, at: Date.now(), ...meta }].slice(-NOTICE_LOG_LIMIT);
    noticeLogRef.current = next;
    if (mountedRef.current) setNoticeLog(next);
  };

  const clearNoticeLog = () => {
    noticeLogRef.current = [];
    if (mountedRef.current) setNoticeLog([]);
  };

  const holdNotice = (id: number) => {
    const running = noticeTimersRef.current.get(id);
    if (running) {
      window.clearTimeout(running.hide);
      window.clearTimeout(running.drop);
    }
    noticeTimersRef.current.set(id, {
      hide: window.setTimeout(() => {
        applyNotices(noticesRef.current.map((notice) => (notice.id === id ? { ...notice, leaving: true } : notice)));
      }, NOTICE_HOLD),
      drop: window.setTimeout(() => {
        noticeTimersRef.current.delete(id);
        applyNotices(noticesRef.current.filter((notice) => notice.id !== id));
      }, NOTICE_HOLD + NOTICE_FADE),
    });
  };

  const notify = (text: string, meta?: NoticeMeta) => {
    setActivity(text);
    const live = noticesRef.current;
    const newest = live.at(-1);
    if (newest && !newest.leaving && newest.text === text) {
      applyNotices([...live.slice(0, -1), { ...newest, count: newest.count + 1, ...meta }]);
      holdNotice(newest.id);
      appendLog(newest.id, text, meta);
      return;
    }
    noticeIdRef.current += 1;
    const id = noticeIdRef.current;
    applyNotices([...live, { id, text, leaving: false, count: 1, ...meta }].slice(-noticeLimitRef.current));
    holdNotice(id);
    appendLog(id, text, meta);
  };

  return { activity, setActivity, notices, noticeLog, notify, clearNoticeLog };
}
