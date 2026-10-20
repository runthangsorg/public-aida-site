import "./strategy.css";
import { renderStrategy } from "./render";
import { emailProblem, reduce, readRoute, type ScreenState } from "./state";
import { GATE_FAILED, HumanCheck, loadTurnstile, withToken, type TurnstileApi } from "../talk/turnstile";

const BASE_TITLE = "Your AI and automation strategy — Aida";

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
const signinHint = byId("signin-hint", HTMLParagraphElement);
const signinNotice = byId("signin-notice", HTMLParagraphElement);
const sentHint = byId("sent-hint", HTMLParagraphElement);
const strategy = byId("strategy", HTMLDivElement);
const form = byId("signin-form", HTMLFormElement);
const emailField = byId("email", HTMLInputElement);
const emailError = byId("email-error", HTMLParagraphElement);
const signinButton = byId("signin-go", HTMLButtonElement);

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

function loadView(): Promise<ApiResponse> {
  if (!token) return Promise.resolve({ status: 404, body: null });
  return request(`/api/strategy/view?t=${encodeURIComponent(token)}`);
}

function dropCode(): void {
  if (new URLSearchParams(location.search).has("c")) {
    history.replaceState(null, "", location.pathname);
  }
}

function show(next: ScreenState): void {
  state = next;
  paint();
}

function paint(): void {
  for (const screen of Object.values(screens)) screen.hidden = true;
  app.dataset.screen = state.screen;

  switch (state.screen) {
    case "loading":
      screens.loading.hidden = false;
      break;
    case "not-found":
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
      document.title = state.view.deck.title ? `${state.view.deck.title} — Aida` : BASE_TITLE;
      screens.view.hidden = false;
      break;
    case "trouble":
      screens.trouble.hidden = false;
      break;
  }
}

async function boot(): Promise<void> {
  const route = readRoute(location.href);
  token = route.token;
  if (!token) {
    show({ screen: "not-found" });
    return;
  }

  show({ screen: "loading" });
  let response = await loadView();

  if (response.status === 401 && route.code) {
    // A one-time code in the address: spend it, then drop it from history.
    const awaiting = reduce(state, { type: "view", status: 401, body: response.body });
    const verified = await request("/api/strategy/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: token, c: route.code }),
    });
    dropCode();
    if (verified.status !== 200) {
      show(reduce(awaiting, { type: "verify", status: verified.status }));
      return;
    }
    show(reduce(state, { type: "verify", status: 200 }));
    response = await loadView();
  } else if (route.code) {
    dropCode();
  }

  show(reduce(state, { type: "view", status: response.status, body: response.body }));
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
  show(reduce(state, { type: "signin", status: attempt.value.status, body: attempt.value.body }));
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

byId("signout", HTMLButtonElement).addEventListener("click", () => {
  if (!token) return;
  show(reduce(state, { type: "signout" }));
  void (async () => {
    await request("/api/strategy/signout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t: token }),
    });
    const response = await loadView();
    show(reduce(state, { type: "view", status: response.status, body: response.body }));
  })();
});

byId("retry", HTMLButtonElement).addEventListener("click", () => {
  void boot();
});

void boot();
