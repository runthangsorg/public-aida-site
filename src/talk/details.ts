// The details form: checked in the browser before anything is sent, with the
// same limits the server applies, and the server's own refusals turned into
// words a person can act on. Pure.

import { GATE_FAILED } from "./turnstile";

export const FIELDS = ["name", "role", "company", "email", "phone", "teamSize", "industry"] as const;
export type Field = (typeof FIELDS)[number];

export type Details = Record<Field, string>;

/** The server cuts each field to these lengths; the form stops typing at the same place. */
export const MAX_LENGTH: Readonly<Record<Field, number>> = {
  name: 80,
  role: 80,
  company: 120,
  email: 160,
  phone: 40,
  teamSize: 40,
  industry: 80,
};

export const TEAM_SIZES = ["Just me", "2–10", "11–50", "51–200", "201–1,000", "More than 1,000"] as const;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PHONE = /^[+()\d\s.-]{6,40}$/;

const REQUIRED: Readonly<Partial<Record<Field, string>>> = {
  name: "Tell us your name.",
  role: "Tell us your role.",
  company: "Tell us your company’s name.",
  email: "We need a work email to send the team’s follow-up.",
  teamSize: "Choose roughly how many people work there.",
  industry: "Tell us your industry, in a few words.",
};

export type Checked = { ok: true; details: Details } | { ok: false; errors: Partial<Record<Field, string>> };

export function checkDetails(raw: Partial<Record<Field, unknown>>): Checked {
  const details = {} as Details;
  for (const f of FIELDS) {
    const v = raw[f];
    details[f] = (typeof v === "string" ? v : "").trim().replace(/\s+/g, " ").slice(0, MAX_LENGTH[f]);
  }
  const errors: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) {
    const message = REQUIRED[f];
    if (message && !details[f]) errors[f] = message;
  }
  if (details.email && !EMAIL.test(details.email)) errors.email = EMAIL_FORMAT;
  if (details.phone && !PHONE.test(details.phone))
    errors.phone = "Use digits, spaces and + ( ) - only, or leave it blank.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, details };
}

/** The body for POST /api/talk/start. The phone number is left out when blank. */
export function startBody(d: Details): Record<string, string | boolean> {
  const body: Record<string, string | boolean> = {
    name: d.name,
    role: d.role,
    company: d.company,
    email: d.email,
    teamSize: d.teamSize,
    industry: d.industry,
    consent: true,
  };
  if (d.phone) body.phone = d.phone;
  return body;
}

export interface StartRefusal {
  message: string;
  field?: Field | "consent";
  /** The person-check was refused (or could not run): show the failure with a Try again button. */
  gate?: true;
}

const FIELD_NAMES = new Set<string>([...FIELDS, "consent"]);

/** A typo and an empty field are different problems, and now say so (QA round 2, breaker). */
export const EMAIL_FORMAT = "That email address does not look right. Please check it.";

const GENERIC_FORM = "Something in the form needs another look.";
const CODE = /^[a-z][a-z_]*$/;

/** A small "78/80" once a capped field is within two characters of its limit, so a cut is never silent. */
export function limitHint(value: string, max: number): string | null {
  return value.length >= max - 2 ? `${value.length}/${max}` : null;
}

/** The 429's words: the server's real wait when it sent one ("Please wait about N minutes"), else the old line. */
function waitMessage(retryAfter: unknown): string {
  const n = Number(retryAfter);
  if (!Number.isFinite(n) || n <= 0) return "Too many tries; please wait a few minutes.";
  const minutes = Math.max(1, Math.ceil(n / 60));
  return `Please wait about ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`;
}

/** What to tell the person when /api/talk/start says no. */
export function refusal(status: number, body: unknown): StartRefusal {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const said = typeof b.error === "string" ? b.error.trim().slice(0, 200) : "";
  // The server names a refusal with a code word (`invalid`, `too_many`); an older reply carried a sentence.
  const code = CODE.test(said) ? said : "";
  const field = typeof b.field === "string" && FIELD_NAMES.has(b.field) ? (b.field as Field | "consent") : undefined;
  let message: string;
  let blame = field;
  if (status === 422 && code === "email_not_accepted") {
    message = "Please use your work email.";
    blame = "email";
  } else {
    switch (status) {
      case 400:
        if (!code && said) message = said;
        else if (field === "email" && b.reason === "format") message = EMAIL_FORMAT;
        else if (field && field !== "consent") message = REQUIRED[field] ?? GENERIC_FORM;
        else message = GENERIC_FORM;
        break;
      case 403:
        message = GATE_FAILED;
        break;
      case 404:
        message = "Interviews are switched off at the moment. Please come back later.";
        break;
      case 429:
        message = waitMessage(b.retryAfter);
        break;
      case 503:
        message = "We couldn’t send the email just now. Please try again in a moment.";
        break;
      default:
        message = !code && said ? said : "Something went wrong starting the interview. Please try again.";
    }
  }
  const out: StartRefusal = blame ? { message, field: blame } : { message };
  if (status === 403) out.gate = true;
  return out;
}
