import fs from "node:fs";
import path from "node:path";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";
import { storageRoot } from "./storage/localDiskProvider.js";

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
// (checked server/package.json) and none is warranted for a 3-format
// magic-byte check, so this is a small, dependency-free addition rather
// than a new library. Each signature is the minimal, well-known byte
// sequence every PNG/JPEG/WebP file begins with; anything else (including
// an SVG re-labelled as one of these three MIME types) fails here even
// though it already passed the MIME-based fileFilter.
function bufferMatchesDeclaredImageType(buffer: Buffer, mimetype: string): boolean {
  if (mimetype === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimetype === "image/jpeg" || mimetype === "image/jpg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimetype === "image/webp") {
    return (
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP"
    );
  }
  return false;
}

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
    if (req.file && !bufferMatchesDeclaredImageType(req.file.buffer, req.file.mimetype)) {
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
