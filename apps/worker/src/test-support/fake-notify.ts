import type { NotifyFn, NotifyInput, NotifyResult } from "../notify/notify";

/** A notify() that records what it was asked to send and sends nothing. */
export function fakeNotify(): { notify: NotifyFn; sent: NotifyInput[] } {
  const sent: NotifyInput[] = [];
  const notify: NotifyFn = async (n) => {
    sent.push(n);
    const r: NotifyResult = { notificationId: null, duplicate: false, delivered: 1, failed: 0, skipped: 0 };
    return r;
  };
  return { notify, sent };
}
