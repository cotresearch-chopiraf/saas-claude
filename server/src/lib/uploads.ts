import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { storageRoot } from "./storage/localDiskProvider.js";
import { matchesFileSignature } from "./fileSignature.js";

// uploadsDir is kept as the public-serving root (app.ts's
// express.static("/uploads", ...)) — it is the same directory
// lib/storage/localDiskProvider.ts writes into (storageRoot), just named
// for its role here (what gets served) rather than its role there (where
// bytes live). Actual file writes now go through lib/storage/ — this
// module only handles the HTTP multipart-upload parsing step (multer),
// buffering the file in memory instead of writing it to disk itself, so
// the route handler can hand the buffer to the storage abstraction and get
// back a `files` metadata row.
export const uploadsDir = storageRoot;
fs.mkdirSync(uploadsDir, { recursive: true });

// Security fix (SVG stored-XSS, read-only audit finding B) — SVG is an XML
// document format: a browser that opens an uploaded file directly (no
// Content-Disposition is set on the public /uploads mount, and none should
// be — see this file's own serving comment) renders it as a live document,
// executing any <script> or onload= handler it contains, in this app's own
// origin. Confirmed exploitable in a real browser against this exact
// endpoint before this fix. PNG/JPEG/WebP have no such capability — a
// raster image format has no executable content model, so direct
// navigation to one is inert regardless of Content-Disposition. SVG is
// therefore removed from the allowed set entirely, not sanitized: this
// app never needed SVG logos specifically, and sanitizing untrusted SVG
// safely is a much larger, easier-to-get-wrong undertaking than simply not
// accepting the one format that can carry a script.
export const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.mimetype)) {
      return cb(new Error("يُسمح فقط بملفات الصور (PNG, JPEG, WEBP)"));
    }
    cb(null, true);
  },
});

// The read-only audit also proved the fileFilter check above is MIME-
// header-only: a client controls the multipart Content-Type field freely,
// so a non-image (or SVG) payload declared as "image/png" passed the
// filter above untouched. This is the actual content check the audit
// asked for — no image-processing dependency exists in this project
// (checked server/package.json) and none is warranted for a magic-byte
// check, so this is a small, dependency-free addition rather than a new
// library. matchesFileSignature (lib/fileSignature.ts) is shared with
// every other upload endpoint in this codebase — see that file's own
// comment for why it was generalized here rather than kept private to
// this one route.

// multer's fileFilter rejection (an unaccepted MIME type) surfaces as a
// plain Error, not a multer.MulterError — the app-wide error handler in
// app.ts only special-cases MulterError into a clean 400, so a plain Error
// from fileFilter fell through to it as a generic 500 (pre-existing
// behavior, found while writing this phase's storage test, fixed here
// since it's the same file this phase is already touching). Wrapping the
// middleware call directly, rather than passing it to the router, lets the
// route catch both MulterError and a fileFilter Error the same way.
export function handleLogoUpload(req: Request, res: Response, next: NextFunction) {
  logoUpload.single("logo")(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "تعذّر رفع الملف";
      return res.status(400).json({ error: message });
    }
    // fileFilter already rejected anything outside png/jpeg/jpg/webp by
    // declared MIME type; this catches a MISMATCHED declaration (the
    // spoofing case the audit demonstrated) now that the buffer is
    // actually available (multer's fileFilter runs before the body is
    // read, so it never has access to file.buffer).
    if (req.file && !matchesFileSignature(req.file.buffer, req.file.mimetype)) {
      return res.status(400).json({ error: "محتوى الملف لا يطابق نوعه المعلن" });
    }
    next();
  });
}

export function logoFileToDataUri(logoPath: string | null): string | null {
  if (!logoPath) return null;
  const absolute = path.resolve(process.cwd(), "." + logoPath);
  if (!absolute.startsWith(uploadsDir) || !fs.existsSync(absolute)) return null;

  const ext = path.extname(absolute).slice(1).toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const base64 = fs.readFileSync(absolute).toString("base64");
  return `data:${mime};base64,${base64}`;
}
