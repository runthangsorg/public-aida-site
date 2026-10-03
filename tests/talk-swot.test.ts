import { describe, expect, it } from "vitest";
import type { Summary } from "../src/talk/protocol";
import { groupNotes } from "../src/talk/state";
import { escapeHtml, renderNotes, renderSummary, renderSwot } from "../src/talk/swot";
import { checkDetails, refusal, startBody } from "../src/talk/details";
import { mouthFor, shapeFromSpectrum } from "../src/talk/mouth";

const summary: Summary = {
  strengths: ["A loyal team", "Clear pricing"],
  weaknesses: ["Rotas live in <b>three</b> spreadsheets"],
  opportunities: [],
  threats: [`"Rising" costs & late payers`],
  crux: "Every approval waits on <script>alert(1)</script> one person.",
  needs: ["Payroll in a day"],
  wants: ["One screen for the week"],
  approach: { bespokeOrCommodity: "Ready-made, set up for us", kind: "Done with us, not for us" },
};

describe("the SWOT read-back", () => {
  it("draws four quadrants in reading order, each with its own list", () => {
    const html = renderSwot(summary);
    const order = ["Strengths", "Weaknesses", "Opportunities", "Threats"].map((q) => html.indexOf(`<h3>${q}</h3>`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("<li>A loyal team</li><li>Clear pricing</li>");
    expect(html).toContain('class="q q-o"');
  });

  it("says so when a quadrant is empty, rather than drawing a blank box", () => {
    expect(renderSwot(summary)).toMatch(/<h3>Opportunities<\/h3><p class="none">Nothing noted\.<\/p>/);
  });

  it("escapes everything that came from the conversation", () => {
    const html = renderSummary(summary);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;three&lt;/b&gt;");
    expect(html).toContain("&quot;Rising&quot; costs &amp; late payers");
    expect(escapeHtml(`<a href='x'>`)).toBe("&lt;a href=&#39;x&#39;&gt;");
  });

  it("adds the crux, the needs, the wants and the approach", () => {
    const html = renderSummary(summary);
    expect(html).toContain("<h3>The crux</h3>");
    expect(html).toContain("<h3>What you need</h3><ul><li>Payroll in a day</li></ul>");
    expect(html).toContain("<h3>What you want</h3><ul><li>One screen for the week</li></ul>");
    expect(html).toContain("<dd>Ready-made, set up for us</dd>");
    expect(html).toContain("<dd>Done with us, not for us</dd>");
  });

  it("leaves out the crux and the approach when she did not settle them", () => {
    const html = renderSummary({ ...summary, crux: "", approach: { bespokeOrCommodity: "", kind: "" } });
    expect(html).not.toContain("The crux");
    expect(html).not.toContain("How you would like it done");
  });

  it("falls back to the notes, grouped and escaped", () => {
    const html = renderNotes(
      groupNotes([
        { id: 1, section: "tools", text: "A <time-tracking> app" },
        { id: 2, section: "org", text: "Two sites" },
      ]),
    );
    expect(html.indexOf("Your organisation")).toBeLessThan(html.indexOf("The tools you use"));
    expect(html).toContain("<li>A &lt;time-tracking&gt; app</li>");
    expect(renderNotes([])).toContain("not written anything");
  });
});

describe("the details form", () => {
  const email = ["test", "example.org"].join("@");
  const good = {
    name: "Test  Person ",
    role: "Operations lead",
    company: "Example Trading",
    email,
    phone: "",
    teamSize: "11–50",
    industry: "Logistics",
  };

  it("accepts a complete form, tidied, and sends no blank phone", () => {
    const checked = checkDetails(good);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.details.name).toBe("Test Person");
    const body = startBody(checked.details);
    expect(body).toMatchObject({ name: "Test Person", email, consent: true });
    expect("phone" in body).toBe(false);
    expect(startBody({ ...checked.details, phone: "+44 20 7946 0000" }).phone).toBe("+44 20 7946 0000");
  });

  it("names every missing or malformed field", () => {
    const checked = checkDetails({ ...good, name: "", email: "test@", phone: "call me", industry: " " });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(Object.keys(checked.errors).sort()).toEqual(["email", "industry", "name", "phone"]);
  });

  it("turns the server's refusals into words, keeping the field it blamed", () => {
    expect(refusal(400, { error: "Check your email.", field: "email" })).toEqual({
      message: "Check your email.",
      field: "email",
    });
    expect(refusal(400, { field: "nonsense" })).toEqual({ message: "Something in the form needs another look." });
    expect(refusal(404, null).message).toMatch(/switched off/);
    expect(refusal(429, {}).message).toMatch(/wait a few minutes/);
    expect(refusal(503, {}).message).toMatch(/try again/);
    expect(refusal(403, {}).message).toMatch(/refused/);
    expect(refusal(500, {}).message).toMatch(/went wrong/);
  });
});

describe("her mouth in a live conversation", () => {
  const spectrum = (low: number, high: number): Uint8Array => {
    const s = new Uint8Array(128);
    for (let i = 3; i < 13; i++) s[i] = low; // 300–1,200 Hz at 24 kHz
    for (let i = 32; i < 85; i++) s[i] = high; // 3–8 kHz
    return s;
  };

  it("is closed and neutral in silence", () => {
    const out = shapeFromSpectrum(new Uint8Array(128), 24_000, { open: 1, spread: 0 });
    expect(out).toEqual({ open: 0, spread: 0.5 });
    expect(mouthFor(out)).toBe("closed");
  });

  it("opens with loudness, rounds on low vowels, spreads on hiss", () => {
    const vowel = shapeFromSpectrum(spectrum(255, 0), 24_000, { open: 0, spread: 0 });
    const hiss = shapeFromSpectrum(spectrum(40, 255), 24_000, { open: 0, spread: 0 });
    expect(vowel.spread).toBe(0);
    expect(hiss.spread).toBeGreaterThan(0.9);
    expect(hiss.open).toBeGreaterThan(vowel.open);
    expect(mouthFor({ open: 0.6, spread: 0.1 })).toBe("round");
    expect(mouthFor({ open: 0.6, spread: 0.8 })).toBe("wide");
    expect(mouthFor({ open: 0.35, spread: 0.6 })).toBe("mid");
    expect(mouthFor({ open: 0.2, spread: 0.1 })).toBe("pucker");
    expect(mouthFor({ open: 0.2, spread: 0.6 })).toBe("small");
  });
});
