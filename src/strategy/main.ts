import "./strategy.css";
import { renderStrategy } from "./render";
import {
  INCOMPLETE_COPY,
  INCOMPLETE_TITLE,
  LOAD_FAILED_COPY,
  NOT_FOUND_COPY,
  NOT_FOUND_TITLE,
  SIGNOUT_FAILED_COPY,
  emailProblem,
  keepCode,
  landing,
  newLinkMailto,
  pageTitle,
  reduce,
  readRoute,
  signOutDone,
  type ScreenState,
} from "./state";
import { GATE_FAILED, HumanCheck, loadTurnstile, withToken, type TurnstileApi } from "./turnstile";

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing #${id}`);
  return node;
}

interface ApiResponse {
  status: number;
  body: unknown;
}

const app = byId("app", HTMLDivElement);
const screens = {
  loading: byId("loading", HTMLElement),
  notFound: byId("not-found", HTMLElement),
  signIn: byId("sign-in", HTMLElement),
  sent: byId("sent", HTMLElement),
  trouble: byId("trouble", HTMLElement),
  view: byId("view", HTMLElement),
};
const notFoundTitle = byId("not-found-title", HTMLHeadingElement);
const notFoundText = byId("not-found-text", HTMLParagraphElement);
const notFoundAsk = byId("not-found-ask", HTMLParagraphElement);
const notFoundMail = byId("not-found-mail", HTMLAnchorElement);
const troubleText = byId("trouble-text", HTMLParagraphElement);
const signinHint = byId("signin-hint", HTMLParagraphElement);
const signinNotice = byId("signin-notice", HTMLParagraphElement);
const sentHint = byId("sent-hint", HTMLParagraphElement);
const strategy = byId("strategy", HTMLDivElement);
const form = byId("signin-form", HTMLFormElement);
const emailField = byId("email", HTMLInputElement);
const emailError = byId("email-error", HTMLParagraphElement);
const signinButton = byId("signin-go", HTMLButtonElement);
const signoutButton = byId("signout", HTMLButtonElement);
const signoutNotice = byId("signout-notice", HTMLParagraphElement);

let token: string | null = null;
let state: ScreenState = { screen: "loading" };

const check = new HumanCheck({
  load: () =>
    loadTurnstile({
      find: () => (window as Window & { turnstile?: TurnstileApi }).turnstile,
      add: (src, onload, onerror) => {
        const script = document.createElement("script");
        script.src = src;
        script.async = true;
        script.onload = onload;
        script.onerror = onerror;
        document.head.append(script);
        return () => {
          script.remove();
        };
      },
    }),
  container: byId("person-check", HTMLDivElement),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => {
    window.clearTimeout(id);
  },
});

async function request(path: string, init?: RequestInit): Promise<ApiResponse> {
  try {
    const response = await fetch(path, init);
    return { status: response.status, body: await response.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

function loadView(t: string): Promise<ApiResponse> {
  return request(`/api/strategy/view?t=${encodeURIComponent(t)}`);
}

/** Only called when the address carries a code: take it out of the address and the history entry. */
function dropCode(): void {
  history.replaceState(null, "", location.pathname);
}

/**
 * Move to a screen. `focus`: the person did something (signed out, sent the form, tried again), so when the
 * screen changes, focus goes to its heading; otherwise it would fall to the page with the button that hid.
 */
function show(next: ScreenState, focus = false): void {
  const changed = next.screen !== state.screen;
  state = next;
  paint();
  if (!focus || !changed) return;
  const heading = Object.values(screens).find((s) => !s.hidden)?.querySelector<HTMLElement>("h1");
  if (!heading) return;
  heading.tabIndex = -1;
  window.scrollTo(0, 0);
  heading.focus({ preventScroll: true });
}

function paint(): void {
  for (const screen of Object.values(screens)) screen.hidden = true;
  app.dataset.screen = state.screen;
  // The strategy's title and the strategy itself stay only while it is on screen: after sign-out neither is
  // left behind in the tab or the page.
  document.title = pageTitle(state);
  if (state.screen !== "view") strategy.replaceChildren();

  switch (state.screen) {
    case "loading":
      screens.loading.hidden = false;
      break;
    case "not-found":
      notFoundTitle.textContent = state.incomplete ? INCOMPLETE_TITLE : NOT_FOUND_TITLE;
      notFoundText.textContent = state.incomplete ? INCOMPLETE_COPY : NOT_FOUND_COPY;
      notFoundAsk.hidden = !state.contact;
      if (state.contact) notFoundMail.href = newLinkMailto(state.contact);
      else notFoundMail.removeAttribute("href");
      screens.notFound.hidden = false;
      break;
    case "sign-in":
      signinHint.textContent = `Use the email you gave Aida (${state.hint})`;
      signinNotice.textContent = state.notice ?? "";
      signinNotice.hidden = state.notice === null;
      signinButton.disabled = false;
      screens.signIn.hidden = false;
      break;
    case "sent":
      sentHint.textContent = `Use the email you gave Aida (${state.hint})`;
      screens.sent.hidden = false;
      break;
    case "view":
      strategy.replaceChildren(renderStrategy(document, state.view));
      signoutNotice.textContent = state.notice ?? "";
      signoutNotice.hidden = !state.notice;
      screens.view.hidden = false;
      break;
    case "trouble":
      troubleText.textContent = state.notice ?? LOAD_FAILED_COPY;
      screens.trouble.hidden = false;
      break;
  }
}

/** `focus`: Try again was pressed, so the screen it ends on takes focus. */
async function boot(focus = false): Promise<void> {
  const route = readRoute(location.href);
  token = route.token;
  const first = landing(route);
  show(first, focus);
  // No token, no request: landing() has already shown the closed link.
  const t = route.token;
  if (!t) return;
  let response = await loadView(t);

  if (response.status === 401 && route.code) {
    // A one-time code in the address: spend it, then drop it from history (unless it never got an answer).
    const awaiting = reduce(state, { type: "view", status: 401, body: response.body });
    const verified = await request("/api/strategy/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t, c: route.code }),
    });
    if (!keepCode(response.status, verified.status)) dropCode();
    if (verified.status !== 200) {
      show(reduce(awaiting, { type: "verify", status: verified.status, body: verified.body }), focus);
      return;
    }
    show(reduce(state, { type: "verify", status: 200 }), focus);
    response = await loadView(t);
  } else if (route.code && !keepCode(response.status)) {
    dropCode();
  }

  show(reduce(state, { type: "view", status: response.status, body: response.body }), focus);
}

async function sendLink(email: string): Promise<void> {
  if (!token) return;
  signinButton.disabled = true;
  const attempt = await withToken(check, (challenge) =>
    request("/api/strategy/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: token, email, turnstile: challenge }),
    }),
  );
  signinButton.disabled = false;
  if (!attempt.ok) {
    if (state.screen === "sign-in") show({ ...state, notice: GATE_FAILED });
    return;
  }
  show(reduce(state, { type: "signin", status: attempt.value.status, body: attempt.value.body }), true);
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const email = emailField.value.trim();
  const problem = emailProblem(email);
  emailError.textContent = problem ?? "";
  emailError.hidden = problem === null;
  emailField.setAttribute("aria-invalid", problem === null ? "false" : "true");
  if (problem) {
    emailField.focus();
    return;
  }
  void sendLink(email);
});

signoutButton.addEventListener("click", () => {
  const t = token;
  if (!t || signoutButton.disabled || state.screen !== "view") return;
  signoutButton.disabled = true;
  const view = state.view;
  show({ screen: "view", view }); // a notice from an earlier try goes, so a new one is read out
  void (async () => {
    const out = await request("/api/strategy/signout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t }),
    });
    signoutButton.disabled = false;
    if (!signOutDone(out.status)) {
      // Still signed in: say so, and keep the strategy, rather than fetching it again as if nothing had happened.
      show({ screen: "view", view, notice: SIGNOUT_FAILED_COPY });
      // Disabling it dropped its focus to the page: give it back, so a keyboard or screen-reader user is still
      // beside the notice. Focus the person moved elsewhere meanwhile is left where it is.
      if (!document.activeElement || document.activeElement === document.body) signoutButton.focus();
      return;
    }
    show(reduce(state, { type: "signout" }), true);
    const response = await loadView(t);
    show(reduce(state, { type: "view", status: response.status, body: response.body }), true);
  })();
});

byId("retry", HTMLButtonElement).addEventListener("click", () => {
  void boot(true);
});

void boot();
