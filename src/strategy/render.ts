// The strategy itself, built as real elements. Every string in the deck came
// from the client (or from the API on their behalf), so it is put on the page
// with `textContent` only: there is no innerHTML and no markup parsing here,
// and a field holding "<script>" stays the five characters a person sees.

import type { StrategyView } from "./state";

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(doc: Document, title: string, className = "block"): HTMLElement {
  const node = el(doc, "section", className);
  node.append(el(doc, "h2", "block-title", title));
  return node;
}

function list(doc: Document, items: readonly string[]): HTMLElement {
  if (items.length === 0) return el(doc, "p", "none", "Nothing noted.");
  const ul = el(doc, "ul", "items");
  for (const item of items) ul.append(el(doc, "li", undefined, item));
  return ul;
}

function numbered(doc: Document, items: readonly string[]): HTMLElement {
  if (items.length === 0) return el(doc, "p", "none", "Nothing noted.");
  const ol = el(doc, "ol", "steps");
  for (const item of items) ol.append(el(doc, "li", undefined, item));
  return ol;
}

const QUADRANTS = [
  ["strengths", "Strengths", "s"],
  ["weaknesses", "Weaknesses", "w"],
  ["opportunities", "Opportunities", "o"],
  ["threats", "Threats", "t"],
] as const;

export function renderStrategy(doc: Document, view: StrategyView): HTMLElement {
  const { deck } = view;
  const article = el(doc, "article", "strategy");
  article.id = "strategy-doc";

  const title = el(doc, "h1", "display", "Your AI and automation strategy");
  title.id = "strategy-title";
  const head = el(doc, "header", "strategy-head");
  head.append(
    el(doc, "p", "kicker", "Your strategy"),
    title,
    el(doc, "p", "company", view.company),
  );
  // The deck's own headline, the outcome in the client's terms, under the company name.
  if (deck.title.trim()) head.append(el(doc, "p", "dek", deck.title));
  head.append(el(doc, "p", "prepared", `Prepared by the Aida team · ${deck.dateLabel}`));
  article.append(head);

  const heard = section(doc, "What we heard");
  heard.append(el(doc, "p", "body", deck.heard.business));
  const crux = el(doc, "aside", "crux");
  crux.append(el(doc, "h3", undefined, "The crux"), el(doc, "p", undefined, deck.heard.crux));
  heard.append(crux);
  article.append(heard);

  const today = section(doc, "Where the time goes today");
  today.append(numbered(doc, deck.heard.today));
  article.append(today);

  const stand = section(doc, "Where you stand");
  stand.append(el(doc, "p", "aside", "Strengths and weaknesses are inside the business; opportunities and threats are outside it."));
  const grid = el(doc, "div", "swot");
  for (const [key, label, cls] of QUADRANTS) {
    const cell = el(doc, "section", `q q-${cls}`);
    cell.append(el(doc, "h3", undefined, label), list(doc, deck.swot[key]));
    grid.append(cell);
  }
  stand.append(grid);
  article.append(stand);

  const start = section(doc, "Where we would start");
  for (const play of deck.plays) {
    const card = el(doc, "article", "play");
    card.append(el(doc, "h3", undefined, play.name));
    const terms = el(doc, "dl", "play-terms");
    const rows: [string, string][] = [
      ["What we would build", play.whatWeWouldBuild],
      ["What changes for you", play.whatChangesForYou],
      ["First step", play.firstStep],
    ];
    for (const [label, text] of rows) {
      terms.append(el(doc, "dt", undefined, label), el(doc, "dd", undefined, text));
    }
    card.append(terms);
    const quote = el(doc, "blockquote", "quote");
    quote.append(el(doc, "p", undefined, play.evidence));
    if (deck.speaker.trim()) quote.append(el(doc, "footer", undefined, `— ${deck.speaker}`));
    card.append(quote);
    start.append(card);
  }
  article.append(start);

  const roadmap = section(doc, "The first 90 days");
  const phases = el(doc, "div", "roadmap");
  for (const phase of deck.roadmap) {
    const column = el(doc, "section", "phase");
    column.append(el(doc, "h3", undefined, phase.when), list(doc, phase.items));
    phases.append(column);
  }
  roadmap.append(phases);
  article.append(roadmap);

  const next = section(doc, "Next step", "block next-step");
  next.append(el(doc, "p", "body", deck.nextStep), el(doc, "p", "reply", "Reply to the team's email"));
  const contact = view.contact?.trim();
  if (contact) {
    const link = el(doc, "a", "contact", "Email the Aida team");
    link.setAttribute("href", `mailto:${contact}`);
    next.append(link);
  }
  article.append(next);

  return article;
}
