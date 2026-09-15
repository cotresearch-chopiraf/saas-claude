// 18-phase internal remediation, Phase 4 — generalizes the magic-byte
// content check the SVG-upload security fix introduced (previously
// lib/uploads.ts's own bufferMatchesDeclaredImageType, image-only) to
// every other upload endpoint in this codebase (documents.ts,
// subcontractIpcDocuments.ts, workforceCompliance.ts's evidence upload),
// which — per that same audit's follow-up sweep — still only checked the
// client-supplied multipart Content-Type, exactly the spoof the SVG fix
// was written to close. Kept dependency-free for the same reason the
// original fix was: no image/document-processing library exists in this
// project, and a magic-byte check is a small, well-understood addition,
// not a reason to add one.
//
// Deliberately checks FORMAT FAMILY, not exact subtype: a modern
// .docx/.xlsx is a ZIP archive and a legacy .doc/.xls is an OLE2
// compound file — Office itself doesn't encode which specific document
// type a ZIP or OLE2 container holds in its outer magic bytes, so this
// only proves "the bytes are actually a well-formed member of the family
// the declared MIME type implies," the same scope the original PNG/JPEG/
// WebP check had (it never verified the pixel data was valid, only that
// the file started with the right signature).
export function matchesFileSignature(buffer: Buffer, mimetype: string): boolean {
  switch (mimetype) {
    case "image/png":
      return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case "image/jpeg":
    case "image/jpg":
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/webp":
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
        buffer.subarray(8, 12).toString("latin1") === "WEBP"
      );
    case "application/pdf":
      return buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
    // Legacy Office binary formats (.doc, .xls) — both are OLE2/Compound
    // File Binary Format containers, sharing this exact signature.
    case "application/msword":
    case "application/vnd.ms-excel":
      return (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
      );
    // Modern Office Open XML formats (.docx, .xlsx) — both are ZIP
    // archives, sharing this exact signature (the non-empty-archive local
    // file header; an Office-produced file is never an empty archive).
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
    default:
      return false;
  }
}
