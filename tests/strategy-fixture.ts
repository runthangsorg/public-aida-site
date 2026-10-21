import type { StrategyView } from "../src/strategy/state";

export const TOKEN = "a".repeat(43);
export const CODE = "b".repeat(43);
export const HINT = "s***@acme.example";
export const SCRIPT = "<script>alert('not markup')</script>";

export function sampleView(): StrategyView {
  return {
    company: "Acme Cleaning (fictional)",
    firstName: "Sam",
    publishedAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
    contact: ["sam", "acme.example"].join("@"),
    deck: {
      title: "AI and automation strategy for Acme Cleaning (fictional)",
      company: "Acme Cleaning (fictional)",
      dateLabel: "20 October 2026",
      heard: {
        business:
          "Acme Cleaning (fictional) cleans forty offices with a team of thirty-five, and the week runs on three spreadsheets.",
        today: [
          "Two supervisors check every timesheet by hand on Friday.",
          "Missed clock-outs are corrected one at a time.",
          "Payroll waits on both of them.",
        ],
        crux: "Every approval waits on two supervisors who are on the road.",
      },
      swot: {
        strengths: ["A loyal team of thirty-five cleaners", "Clear pricing"],
        weaknesses: ["Rotas live in three spreadsheets"],
        opportunities: ["Automate the Friday approvals"],
        threats: ["Rising wages"],
      },
      plays: [
        {
          name: "Friday approvals on one screen",
          whatWeWouldBuild: "A single approval list that fills itself from the clock-in data.",
          whatChangesForYou: "The supervisors approve from their phones, in ten minutes.",
          firstStep: "Map the three spreadsheets with the two supervisors.",
          evidence: "Every approval waits on two supervisors who are on the road.",
        },
      ],
      roadmap: [
        { when: "First 30 days", items: ["Map the spreadsheets", "Agree the rules"] },
        { when: "30-60 days", items: ["Build the approval list"] },
        { when: "60-90 days", items: ["Run payroll from it"] },
      ],
      nextStep: "Reply with a time next week and we will walk the supervisors through it.",
      speaker: "Aida",
    },
  };
}
