// The details form: checked in the browser before anything is sent, with the
// same limits the server applies, and the server's own refusals turned into
// words a person can act on. Pure.

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
  if (details.email && !EMAIL.test(details.email)) errors.email = "That email address doesn’t look complete.";
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
}

const FIELD_NAMES = new Set<string>([...FIELDS, "consent"]);

/** What to tell the person when /api/talk/start says no. */
export function refusal(status: number, body: unknown): StartRefusal {
  const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const said = typeof b.error === "string" ? b.error.trim().slice(0, 200) : "";
  const field = typeof b.field === "string" && FIELD_NAMES.has(b.field) ? (b.field as Field | "consent") : undefined;
  let message: string;
  switch (status) {
    case 400:
      message = said || "Something in the form needs another look.";
      break;
    case 403:
      message = "This browser was refused. Try again from another network or device.";
      break;
    case 404:
      message = "Interviews are switched off at the moment. Please come back later.";
      break;
    case 429:
      message = "Too many interviews started from here just now. Please wait a few minutes and try again.";
      break;
    case 503:
      message = "Aida can’t take a call right now. Please try again in a little while.";
      break;
    default:
      message = said || "Something went wrong starting the interview. Please try again.";
  }
  return field ? { message, field } : { message };
}
