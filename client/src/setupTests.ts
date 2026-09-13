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
if (typeof File !== "undefined" && !("text" in File.prototype)) {
  File.prototype.text = function (this: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}
