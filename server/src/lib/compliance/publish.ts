import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { complianceRuleVersions } from "../../db/schema.js";
import { getCountryPack } from "./packs/index.js";
import type { ComplianceRules, CountryCode } from "./types.js";

export class CompliancePublishError extends Error {}

// Seeds the very first published rule version for a country, if none
// exists yet. Idempotent — safe to call on every server start or on first
// use. There is no "previous version" to regress for a country's first
// version, so this is the one publish path that does not require a
// separate human review step; every SUBSEQUENT version for that country
// goes through publishNewRuleVersion below instead.
export async function ensureInitialRuleVersion(countryCode: CountryCode): Promise<string> {
  const existing = await db.query.complianceRuleVersions.findFirst({
    where: and(eq(complianceRuleVersions.countryCode, countryCode), eq(complianceRuleVersions.status, "published")),
  });
  if (existing) return existing.id;

  const pack = getCountryPack(countryCode);
  if (!pack) throw new CompliancePublishError(`No country pack registered for ${countryCode}`);

  const meta = pack.getSeedVersionMeta();
  const rules = pack.getSeedRules();

  const [version] = await db
    .insert(complianceRuleVersions)
    .values({
      countryCode,
      version: meta.version,
      status: "published",
      effectiveFrom: meta.effectiveFrom,
      rules,
      sourceUrl: meta.sourceUrl,
      sourceType: meta.sourceType,
      publicationDate: meta.publicationDate,
      retrievedAt: new Date(),
      verificationStatus: meta.verificationStatus,
      publishedAt: new Date(),
    })
    .returning();

  return version.id;
}

export interface PublishNewRuleVersionInput {
  countryCode: CountryCode;
  version: string;
  effectiveFrom: string;
  rules: ComplianceRules;
  sourceUrl: string;
  sourceType: "official_government" | "official_regulation" | "verified_professional";
  publicationDate: string | null;
  verificationStatus: "verified" | "unverified" | "review_required";
  publishedBy: string;
}

// The controlled path for a REGULATORY UPDATE (as opposed to a country's
// initial seed): the previously-published version for this country is
// closed off (effectiveTo = the new version's effectiveFrom, status =
// superseded) and a new version is inserted — it never rewrites the old
// row. This never runs automatically; it exists to be called by an
// explicit, human-triggered admin action (see the implementation report's
// notes on Phase 13 — AI research proposes a version, a human calls this
// to publish it, nothing calls this on its own).
export async function publishNewRuleVersion(input: PublishNewRuleVersionInput): Promise<string> {
  return db.transaction(async (tx) => {
    const previous = await tx.query.complianceRuleVersions.findFirst({
      where: and(
        eq(complianceRuleVersions.countryCode, input.countryCode),
        eq(complianceRuleVersions.status, "published"),
        isNull(complianceRuleVersions.effectiveTo),
      ),
    });

    if (previous) {
      await tx
        .update(complianceRuleVersions)
        .set({ status: "superseded", effectiveTo: input.effectiveFrom })
        .where(eq(complianceRuleVersions.id, previous.id));
    }

    const [version] = await tx
      .insert(complianceRuleVersions)
      .values({
        countryCode: input.countryCode,
        version: input.version,
        status: "published",
        effectiveFrom: input.effectiveFrom,
        rules: input.rules,
        sourceUrl: input.sourceUrl,
        sourceType: input.sourceType,
        publicationDate: input.publicationDate,
        retrievedAt: new Date(),
        verificationStatus: input.verificationStatus,
        publishedAt: new Date(),
        publishedBy: input.publishedBy,
      })
      .returning();

    return version.id;
  });
}
