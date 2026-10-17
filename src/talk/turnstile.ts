// The invisible "are you a person" check on the registration form (Cloudflare
// Turnstile). The script is third-party and heavy, so it is loaded only when the
// details form is first shown: the intro stays script-free. A token is single-use,
// so the widget is reset after every attempt. If the script cannot load, the
// challenge fails, or nothing answers within 15 s, the form is not submitted.
// Pure of the page: the script loader, the container and the timers are passed in,
// so the whole flow is tested in Node with a fake widget.

/** The widget's public site key (a public value). */
export const SITE_KEY = "0x4AAAAAAFZTdtD16pKQUQq6";
export const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** The request header the server reads the token from. */
export const TOKEN_HEADER = "X-Aida-Turnstile";
export const CHALLENGE_TIMEOUT_MS = 15_000;

export const GATE_FAILED =
  "We could not check that you are a person. Switch off any blocker for this page, or try another browser.";

export interface RenderOptions {
  sitekey: string;
  execution: "execute";
  appearance: "interaction-only";
  callback: (token: string) => void;
  "error-callback": (code?: unknown) => void;
  "expired-callback": () => void;
  "timeout-callback": () => void;
}

/** The part of `window.turnstile` this page uses. */
export interface TurnstileApi {
  render(container: unknown, options: RenderOptions): string;
  execute(container: unknown): void;
  reset(widgetId: string): void;
}

export interface CheckDeps {
  /** Load the vendor script (once per attempt that needs it) and give back its API. */
  load(): Promise<TurnstileApi>;
  /** An empty, out-of-flow element: the widget draws nothing in it unless a person must act. */
  container: unknown;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export type TokenResult = { ok: true; token: string } | { ok: false; reason: "script" | "challenge" | "timeout" };

export class HumanCheck {
  constructor(private readonly deps: CheckDeps) {}

  private api: TurnstileApi | null = null;
  private widget: string | null = null;
  private ready: Promise<void> | null = null;
  /** Settles the attempt in flight; null when none. */
  private waiting: ((r: TokenResult) => void) | null = null;

  /** Load the script and draw the (invisible) widget. Safe to call often; a failure is retried next time. */
  prepare(): Promise<void> {
    this.ready ??= this.deps.load().then(
      (api) => {
        this.api = api;
        this.widget = api.render(this.deps.container, {
          sitekey: SITE_KEY,
          execution: "execute",
          appearance: "interaction-only",
          callback: (token) => {
            this.waiting?.(token ? { ok: true, token } : { ok: false, reason: "challenge" });
          },
          "error-callback": () => {
            this.waiting?.({ ok: false, reason: "challenge" });
          },
          "expired-callback": () => {
            this.waiting?.({ ok: false, reason: "challenge" });
          },
          "timeout-callback": () => {
            this.waiting?.({ ok: false, reason: "timeout" });
          },
        });
      },
      (err: unknown) => {
        this.ready = null; // the next attempt loads the script afresh
        throw err;
      },
    );
    return this.ready;
  }

  /** Run the challenge and wait (at most 15 s) for its token. Never throws. */
  token(): Promise<TokenResult> {
    return new Promise<TokenResult>((resolve) => {
      let done = false;
      const finish = (r: TokenResult): void => {
        if (done) return;
        done = true;
        this.deps.clearTimeout(timer);
        this.waiting = null;
        resolve(r);
      };
      const timer = this.deps.setTimeout(() => {
        finish({ ok: false, reason: "timeout" });
      }, CHALLENGE_TIMEOUT_MS);
      this.prepare().then(
        () => {
          if (done || !this.api) return;
          this.waiting = finish;
          try {
            this.api.execute(this.deps.container);
          } catch {
            finish({ ok: false, reason: "challenge" });
          }
        },
        () => {
          finish({ ok: false, reason: "script" });
        },
      );
    });
  }

  /** A token is single-use: after every attempt, the widget is made ready for the next. Idempotent. */
  reset(): void {
    if (this.api && this.widget !== null) {
      try {
        this.api.reset(this.widget);
      } catch {
        // a widget the vendor has already removed
      }
    }
  }
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: "script" | "challenge" | "timeout" };

/** Get a token, hand it to `send`, and reset the widget however that went. */
export async function withToken<T>(check: HumanCheck, send: (token: string) => Promise<T>): Promise<Attempt<T>> {
  const got = await check.token();
  try {
    if (!got.ok) return got;
    return { ok: true, value: await send(got.token) };
  } finally {
    check.reset();
  }
}

// ---------- the vendor script ----------

/** The page, as the loader needs it. */
export interface ScriptHost {
  /** The vendor's global, if the script has already run. */
  find(): TurnstileApi | undefined;
  /** Append the script; returns a function that removes it again. */
  add(src: string, onload: () => void, onerror: () => void): () => void;
}

export function loadTurnstile(host: ScriptHost): Promise<TurnstileApi> {
  return new Promise<TurnstileApi>((resolve, reject) => {
    const present = host.find();
    if (present) {
      resolve(present);
      return;
    }
    const remove = host.add(
      SCRIPT_SRC,
      () => {
        const api = host.find();
        if (api) resolve(api);
        else {
          remove();
          reject(new Error("turnstile missing"));
        }
      },
      () => {
        remove();
        reject(new Error("turnstile script failed"));
      },
    );
  });
}
