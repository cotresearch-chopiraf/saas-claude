import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Without this, each test's render() leaves its DOM mounted for the next
// test in the same file — the exact failure mode that surfaced during
// UI-Foundation's own test authoring (a later test finding multiple
// matches because two renders' sidebars were both still in the document).
afterEach(cleanup);

// jsdom's File/Blob polyfill does not implement the standard .text()
// method (well-supported in every real browser since ~2020) — without
// this, any component that reads an uploaded file's contents client-side
// (PlatformTenantImport.tsx's import-file picker) throws "f.text is not a
// function" in tests only, never in a real browser. A real, minimal
// polyfill (FileReader IS implemented in jsdom), not a mock — it reads the
// actual bytes the test constructed the File from.
//
// The existence check and the assignment both go through a plain
// Record<string, unknown> view of File.prototype rather than File's own
// declared type. lib.dom.d.ts declares .text() as always present (inherited
// from Blob), so checking `"text" in File.prototype` against File's own
// type makes TypeScript prove the "missing" branch unreachable and narrow
// File.prototype itself to `never` there — a real compiler error, not a
// runtime one (jsdom's actual object lacks the method regardless of what
// the types claim). Record<string, unknown> has no declared members for
// TypeScript to reason about, so it can't apply that (correct, but
// unhelpful here) exhaustiveness narrowing.
if (typeof File !== "undefined") {
  const proto = File.prototype as unknown as Record<string, unknown>;
  if (typeof proto.text !== "function") {
    proto.text = function (this: File): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
}
