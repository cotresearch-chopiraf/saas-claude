import fs from "node:fs";
import path from "node:path";
import multer from "multer";

// Local disk storage — a stopgap until real object storage (S3/R2) is wired
// up. Fine for a single persistent server; files are lost on redeploy to an
// ephemeral host, so this must be swapped before a serverless deployment.
export const uploadsDir = path.resolve(process.cwd(), "uploads");
export const logosDir = path.join(uploadsDir, "logos");
fs.mkdirSync(logosDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, logosDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `${req.companyId}-${Date.now()}${ext}`);
  },
});

export const logoUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpeg|jpg|webp|svg\+xml)$/.test(file.mimetype)) {
      return cb(new Error("يُسمح فقط بملفات الصور (PNG, JPEG, WEBP, SVG)"));
    }
    cb(null, true);
  },
});

export function logoFileToDataUri(logoPath: string | null): string | null {
  if (!logoPath) return null;
  const absolute = path.resolve(process.cwd(), "." + logoPath);
  if (!absolute.startsWith(uploadsDir) || !fs.existsSync(absolute)) return null;

  const ext = path.extname(absolute).slice(1).toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}`;
  const base64 = fs.readFileSync(absolute).toString("base64");
  return `data:${mime};base64,${base64}`;
}
