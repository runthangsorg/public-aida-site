// The end of the conversation, as HTML: what she heard, drawn as a SWOT
// (strengths and weaknesses inside the business, opportunities and threats
// outside it), then the crux, what the person needs, what they want and how
// they would like it done. Every string came from the conversation, so every
// string is escaped; nothing here trusts its input.

import type { Summary } from "./protocol";
import { noteStamp, type NoteGroup } from "./state";

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function items(list: readonly string[], none = "Nothing noted."): string {
  if (list.length === 0) return `<p class="none">${none}</p>`;
  return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

const QUADRANTS = [
  ["strengths", "Strengths", "s"],
  ["weaknesses", "Weaknesses", "w"],
  ["opportunities", "Opportunities", "o"],
  ["threats", "Threats", "t"],
] as const;

/** The 2×2: columns are what helps and what hurts, rows are inside the business and outside it. */
export function renderSwot(summary: Summary): string {
  const cells = QUADRANTS.map(
    ([key, label, cls]) =>
      `<section class="q q-${cls}" data-l="${cls.toUpperCase()}"><h3>${label}</h3>${items(summary[key])}</section>`,
  ).join("");
  return (
    `<figure class="swot">` +
    `<figcaption class="visually-hidden">Strengths and weaknesses are inside the business; opportunities and threats are outside it.</figcaption>` +
    `<span class="axis axis-help" aria-hidden="true">Helps</span>` +
    `<span class="axis axis-hurt" aria-hidden="true">Hurts</span>` +
    `<span class="axis axis-in" aria-hidden="true">Inside</span>` +
    `<span class="axis axis-out" aria-hidden="true">Outside</span>` +
    `<div class="swot-grid">${cells}</div>` +
    `</figure>`
  );
}

export function renderSummary(summary: Summary): string {
  const crux = summary.crux
    ? `<section class="crux"><h3>The crux</h3><p>${escapeHtml(summary.crux)}</p></section>`
    : "";
  const { bespokeOrCommodity, kind } = summary.approach;
  const approach =
    bespokeOrCommodity || kind
      ? `<section class="approach"><h3>How you would like it done</h3><dl>` +
        (bespokeOrCommodity ? `<dt>Made for you, or ready-made</dt><dd>${escapeHtml(bespokeOrCommodity)}</dd>` : "") +
        (kind ? `<dt>The kind of help</dt><dd>${escapeHtml(kind)}</dd>` : "") +
        `</dl></section>`
      : "";
  return (
    renderSwot(summary) +
    crux +
    `<div class="pair">` +
    `<section class="need"><h3>What you need</h3>${items(summary.needs)}</section>` +
    `<section class="want"><h3>What you want</h3>${items(summary.wants)}</section>` +
    `</div>` +
    approach
  );
}

/** When the conversation ended without a summary: the notes she took, by section. */
export function renderNotes(groups: readonly NoteGroup[]): string {
  if (groups.length === 0) return `<p class="none">She had not written anything down yet.</p>`;
  return groups
    .map(
      (g) =>
        `<section class="nb-group" data-section="${escapeHtml(g.section)}"><h3>${escapeHtml(g.label)}</h3>` +
        `<ul>${g.notes.map((n) => `<li><time class="note-time">${noteStamp(n.at)}</time>${escapeHtml(n.text)}</li>`).join("")}</ul></section>`,
    )
    .join("");
}
