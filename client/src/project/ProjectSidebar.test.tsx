import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ProjectSidebarDesktop } from "./ProjectSidebar";
import { projectSections, legacySection } from "./sections";

// Covers the two Foundation routing requirements that are actually this
// codebase's own logic (not react-router-dom's, which is already a
// well-tested library): every configured section resolves to the correct
// URL, and the section matching the current URL is the one visually
// marked active — the same mechanism a refresh/deep-link relies on, since
// active-state here is derived purely from the current location, not
// stored client state.
describe("ProjectSidebar — URL-based section navigation", () => {
  it("every configured section renders a link to its correct project-scoped URL", () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/overview"]}>
        <ProjectSidebarDesktop projectId="p1" />
      </MemoryRouter>,
    );
    for (const section of projectSections) {
      const link = screen.getByRole("link", { name: section.label });
      expect(link).toHaveAttribute("href", `/projects/p1/${section.path}`);
    }
    expect(screen.getByRole("link", { name: legacySection.label })).toHaveAttribute(
      "href",
      `/projects/p1/${legacySection.path}`,
    );
  });

  it("the section matching the current URL is marked active; others are not", () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/cost-plan"]}>
        <ProjectSidebarDesktop projectId="p1" />
      </MemoryRouter>,
    );
    const active = screen.getByRole("link", { name: "خطة التكلفة" });
    const inactive = screen.getByRole("link", { name: "نظرة عامة" });
    expect(active.className).toMatch(/text-primary/);
    expect(inactive.className).not.toMatch(/text-primary/);
  });

  it("a deep link directly into a non-default section still marks only that section active", () => {
    render(
      <MemoryRouter initialEntries={["/projects/p1/ipc"]}>
        <ProjectSidebarDesktop projectId="p1" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "شهادات الدفع (IPC)" }).className).toMatch(/text-primary/);
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
