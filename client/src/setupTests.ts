import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Without this, each test's render() leaves its DOM mounted for the next
// test in the same file — the exact failure mode that surfaced during
// UI-Foundation's own test authoring (a later test finding multiple
// matches because two renders' sidebars were both still in the document).
afterEach(cleanup);
