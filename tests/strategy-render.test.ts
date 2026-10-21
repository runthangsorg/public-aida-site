import { describe, expect, it } from "vitest";
import { renderStrategy } from "../src/strategy/render";
import type { StrategyView } from "../src/strategy/state";
import { SCRIPT, sampleView } from "./strategy-fixture";

/** Enough of the DOM for the renderer, and no HTML parser at all: setting innerHTML is a failure. */
class FakeElement {
  readonly tagName: string;
  className = "";
  id = "";
  readonly attributes = new Map<string, string>();
  readonly children: (FakeElement | string)[] = [];
  #text: string | null = null;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  set textContent(value: string | null) {
    this.#text = value;
    this.children.length = 0;
  }

  get textContent(): string {
    if (this.children.length > 0) {
      return this.children.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
    }
    return this.#text ?? "";
  }

  append(...nodes: (FakeElement | string)[]): void {
    this.children.push(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  set innerHTML(_value: string) {
    throw new Error("innerHTML must not be used");
  }

  set outerHTML(_value: string) {
    throw new Error("outerHTML must not be used");
  }
}

class FakeDocument {
  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName.toLowerCase());
  }
}

const render = (view: StrategyView): FakeElement =>
  renderStrategy(new FakeDocument() as unknown as Document, view) as unknown as FakeElement;

function walk(node: FakeElement, found: FakeElement[] = []): FakeElement[] {
  found.push(node);
  for (const child of node.children) if (typeof child !== "string") walk(child, found);
  return found;
}

describe("rendering the strategy", () => {
  it("puts every deck string on the page as text, never as markup", () => {
    const view = sampleView();
    view.company = SCRIPT;
    view.deck.heard.business = SCRIPT;
    const [play] = view.deck.plays;
    if (!play) throw new Error("the fixture has no play");
    play.name = SCRIPT;
    play.evidence = SCRIPT;

    const article = render(view);
    const nodes = walk(article);

    expect(nodes.some((node) => node.tagName === "script")).toBe(false);
    expect(article.textContent).toContain(SCRIPT);
    expect(article.textContent.split(SCRIPT).length - 1).toBeGreaterThanOrEqual(4);
    expect(article.textContent).toContain("Prepared by the Aida team");
  });

  it("draws the header, the six sections and the speaker's name", () => {
    const view = sampleView();
    const article = render(view);
    const nodes = walk(article);

    expect(nodes.find((node) => node.tagName === "h1")?.textContent).toBe(
      "Your AI and automation strategy",
    );
    expect(nodes.find((node) => node.className === "company")?.textContent).toBe(view.company);
    expect(nodes.find((node) => node.className === "prepared")?.textContent).toBe(
      `Prepared by the Aida team · ${view.deck.dateLabel}`,
    );
    expect(nodes.filter((node) => node.tagName === "h2").map((node) => node.textContent)).toEqual([
      "What we heard",
      "Where the time goes today",
      "Where you stand",
      "Where we would start",
      "The first 90 days",
      "Next step",
    ]);
    expect(article.textContent).toContain("— Aida");
  });

  it("draws the SWOT as four labelled quadrants and the roadmap as three phases", () => {
    const view = sampleView();
    const article = render(view);
    const nodes = walk(article);

    expect(
      nodes.filter((node) => node.className.startsWith("q q-")).map((node) => node.className),
    ).toEqual(["q q-s", "q q-w", "q q-o", "q q-t"]);
    const phases = nodes.filter((node) => node.className === "phase");
    expect(phases.map((phase) => (phase.children[0] as FakeElement).textContent)).toEqual([
      "First 30 days",
      "30-60 days",
      "60-90 days",
    ]);
  });

  it("shows the deck's own headline under the company, as text", () => {
    const view = sampleView();
    const dek = walk(render(view)).find((node) => node.className === "dek");
    expect(dek?.textContent).toBe(view.deck.title);

    view.deck.title = SCRIPT;
    const hostile = walk(render(view));
    expect(hostile.some((node) => node.tagName === "script")).toBe(false);
    expect(hostile.find((node) => node.className === "dek")?.textContent).toBe(SCRIPT);

    view.deck.title = "";
    expect(walk(render(view)).find((node) => node.className === "dek")).toBeUndefined();
  });

  it("signs a quote only when there is someone to sign it", () => {
    const view = sampleView();
    view.deck.speaker = "";
    const article = render(view);
    expect(article.textContent).not.toContain("— ");
    expect(walk(article).filter((node) => node.tagName === "blockquote")).toHaveLength(view.deck.plays.length);
  });

  it("offers a mailto link only when the view carries a contact", () => {
    const view = sampleView();
    const withContact = walk(render(view)).find(
      (node) => node.className === "contact",
    );
    expect(withContact?.textContent).toBe("Email the Aida team");
    expect(withContact?.attributes.get("href")).toBe(`mailto:${view.contact ?? ""}`);

    const without = sampleView();
    without.contact = null;
    const link = walk(render(without)).find(
      (node) => node.className === "contact",
    );
    expect(link).toBeUndefined();
  });
});
