// The page's own event log. A handful of named events go to /api/event on this
// same site (the aida deployment's functions/api/event.ts checks them against
// the same list and stores them without cookies or IP addresses). Nothing is
// stored in the browser: `visit` is made fresh for each page load, only to tie
// that load's events together. Sending never blocks or breaks the page.

export const EVENTS = {
  view: ["motion", "still"],
  voice: ["sound", "silent"],
  tap: ["sound"],
  complete: ["sound", "silent"],
  stop: ["sound"],
  replay: ["sound"],
} as const;

export type EventName = keyof typeof EVENTS;
export type Detail<E extends EventName> = (typeof EVENTS)[E][number];

export function newVisitId(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return Array.from(random(new Uint8Array(10)), (b) => (b % 36).toString(36)).join("");
}

/** The body sent for one event: the referrer reduced to its origin, never its path or query. */
export function eventBody<E extends EventName>(
  event: E,
  detail: Detail<E>,
  visit: string,
  path: string,
  referrer: string,
): string {
  let origin: string | undefined;
  try {
    origin = referrer ? new URL(referrer).origin : undefined;
  } catch {
    origin = undefined;
  }
  return JSON.stringify({ e: event, d: detail, v: visit, p: path, r: origin });
}

const visit = newVisitId();

export function track<E extends EventName>(event: E, detail: Detail<E>): void {
  try {
    const body = eventBody(event, detail, visit, location.pathname, document.referrer);
    const blob = new Blob([body], { type: "text/plain" });
    if (!navigator.sendBeacon("/api/event", blob)) {
      void fetch("/api/event", { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(
        () => undefined,
      );
    }
  } catch {
    // Analytics must never break the page.
  }
}
