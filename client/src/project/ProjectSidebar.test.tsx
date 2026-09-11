import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ProjectSidebarDesktop } from "./ProjectSidebar";
import { projectSections, legacySection } from "./sections";
import { I18nProvider } from "../i18n/I18nProvider";
import ar from "../i18n/translations/ar";

// ar.ts's project.sections/legacyBudget values are verbatim copies of what
// used to be hardcoded directly in sections.ts, so these lookups resolve to
// the exact same Arabic strings this test suite always asserted — the
// default locale (ar) matches what these tests expect without needing a
// language switch.
function sectionLabel(key: string): string {
  return ar.project.sections[key as keyof typeof ar.project.sections];
}
const legacyLabel = ar.project.legacyBudget;

function renderSidebar(initialEntries: string[]) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={initialEntries}>
        <ProjectSidebarDesktop projectId="p1" />
      </MemoryRouter>
    </I18nProvider>,
  );
}

// Covers the two Foundation routing requirements that are actually this
// codebase's own logic (not react-router-dom's, which is already a
// well-tested library): every configured section resolves to the correct
// URL, and the section matching the current URL is the one visually
// marked active — the same mechanism a refresh/deep-link relies on, since
// active-state here is derived purely from the current location, not
// stored client state.
describe("ProjectSidebar — URL-based section navigation", () => {
  it("every configured section renders a link to its correct project-scoped URL", () => {
    renderSidebar(["/projects/p1/overview"]);
    for (const section of projectSections) {
      const link = screen.getByRole("link", { name: sectionLabel(section.key) });
      expect(link).toHaveAttribute("href", `/projects/p1/${section.path}`);
    }
    expect(screen.getByRole("link", { name: legacyLabel })).toHaveAttribute(
      "href",
      `/projects/p1/${legacySection.path}`,
    );
  });

  it("the section matching the current URL is marked active; others are not", () => {
    renderSidebar(["/projects/p1/cost-plan"]);
    const active = screen.getByRole("link", { name: sectionLabel("cost-plan") });
    const inactive = screen.getByRole("link", { name: sectionLabel("overview") });
    expect(active.className).toMatch(/text-primary/);
    expect(inactive.className).not.toMatch(/text-primary/);
  });

  it("a deep link directly into a non-default section still marks only that section active", () => {
    renderSidebar(["/projects/p1/ipc"]);
    expect(screen.getByRole("link", { name: sectionLabel("ipc") }).className).toMatch(/text-primary/);
  });

  it("the legacy section is never grouped inside projectSections (stays visually/structurally separate)", () => {
    expect(projectSections.some((s) => s.key === legacySection.key)).toBe(false);
  });

  it("every section has a unique key and a unique path", () => {
    const keys = projectSections.map((s) => s.key);
    const paths = projectSections.map((s) => s.path);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
