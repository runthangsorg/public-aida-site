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
  const RATE = 24_000;
  const BINS = 512; // FFT_SIZE 1024
  /** A dB spectrum with a quiet floor and peaks at the given frequencies. */
  const spectrum = (peaks: [number, number][]): Float32Array => {
    const db = new Float32Array(BINS).fill(-110);
    const binHz = RATE / (2 * BINS);
    for (const [hz, level] of peaks) {
      const c = Math.round(hz / binHz);
      for (let d = -2; d <= 2; d++) if (c + d > 0 && c + d < BINS) db[c + d] = level - Math.abs(d) * 6;
    }
    return db;
  };
  const wave = (amp: number): Float32Array => Float32Array.from({ length: 1024 }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / RATE));
  const read = (peaks: [number, number][], amp = 0.3) => {
    const out = { open: 0, spread: 0.5, peak: 0.3 };
    shapeFromSpectrum(spectrum(peaks), wave(amp), RATE, out);
    return out;
  };

  it("is closed and neutral in silence", () => {
    const out = shapeFromSpectrum(spectrum([]), new Float32Array(1024), RATE, { open: 1, spread: 0 });
    expect([out.open, out.spread]).toEqual([0, 0.5]);
    expect(mouthFor(out)).toBe("closed");
  });

  it("tells vowels apart by their formants (owner, 3 Oct: the shapes did not match the words)", () => {
    expect(mouthFor(read([[750, -20], [1200, -24]]))).toBe("wide"); // "ah": jaw open
    expect(mouthFor(read([[500, -20], [900, -24]]))).toBe("round"); // "oh": rounded, half open
    expect(mouthFor(read([[320, -20], [800, -24]]))).toBe("pucker"); // "oo": rounded, nearly closed
    expect(mouthFor(read([[300, -20], [2300, -24]]))).toBe("small"); // "ee": spread, jaw closed
  });

  it("gives the small mouth for hiss", () => {
    expect(mouthFor(read([[6000, -15], [7000, -15], [500, -60]]))).toBe("small"); // "s"
  });

  it("scales opening to her own recent loudness, so a quiet voice still moves the mouth", () => {
    const quiet = { open: 0, spread: 0.5, peak: 0.05 };
    shapeFromSpectrum(spectrum([[750, -20], [1200, -24]]), wave(0.04), RATE, quiet);
    expect(quiet.open).toBeGreaterThan(0.5);
  });

  it("picks each of the drawn mouths somewhere in its range", () => {
    expect(mouthFor({ open: 0.6, spread: 0.1 })).toBe("round");
    expect(mouthFor({ open: 0.6, spread: 0.8 })).toBe("wide");
    expect(mouthFor({ open: 0.35, spread: 0.6 })).toBe("mid");
    expect(mouthFor({ open: 0.2, spread: 0.1 })).toBe("pucker");
    expect(mouthFor({ open: 0.2, spread: 0.6 })).toBe("small");
  });
});
