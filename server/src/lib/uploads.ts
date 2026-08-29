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

export const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpeg|jpg|webp|svg\+xml)$/.test(file.mimetype)) {
      return cb(new Error("يُسمح فقط بملفات الصور (PNG, JPEG, WEBP, SVG)"));
    }
    cb(null, true);
  },
});

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
