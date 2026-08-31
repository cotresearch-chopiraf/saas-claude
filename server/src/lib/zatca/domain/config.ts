// Tenant ZATCA identity configuration (Slice 3) — VAT number / commercial
// registration, stored in the existing company_tax_identifiers table
// (countryCode fixed to "SA", since ZATCA is Saudi-specific) rather than
// new columns. companies.name/address are read here but never written —
// those stay owned by routes/company.ts's own settings route, per "ZATCA
// must consume MIDAD's existing data, not redefine it."

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { companies, companyTaxIdentifiers } from "../../../db/schema.js";

const VAT_NUMBER_TYPE = "vat_number";
const COMMERCIAL_REGISTRATION_TYPE = "commercial_registration";
const ZATCA_COUNTRY = "SA" as const;

export interface ZatcaTenantIdentity {
  legalName: string | null;
  address: string | null;
  vatNumber: string | null;
  commercialRegistration: string | null;
}

export async function getZatcaTenantIdentity(companyId: string): Promise<ZatcaTenantIdentity> {
  const [company, identifiers] = await Promise.all([
    db.query.companies.findFirst({ where: eq(companies.id, companyId), columns: { name: true, address: true } }),
    db.query.companyTaxIdentifiers.findMany({
      where: and(eq(companyTaxIdentifiers.companyId, companyId), eq(companyTaxIdentifiers.countryCode, ZATCA_COUNTRY)),
    }),
  ]);
  const byType = new Map(identifiers.map((row) => [row.identifierType, row.value]));
  return {
    legalName: company?.name ?? null,
    address: company?.address ?? null,
    vatNumber: byType.get(VAT_NUMBER_TYPE) ?? null,
    commercialRegistration: byType.get(COMMERCIAL_REGISTRATION_TYPE) ?? null,
  };
}

export interface UpdateZatcaTenantIdentityInput {
  vatNumber?: string;
  commercialRegistration?: string;
}

async function upsertIdentifier(companyId: string, identifierType: string, value: string): Promise<void> {
  const existing = await db.query.companyTaxIdentifiers.findFirst({
    where: and(
      eq(companyTaxIdentifiers.companyId, companyId),
      eq(companyTaxIdentifiers.identifierType, identifierType),
      eq(companyTaxIdentifiers.countryCode, ZATCA_COUNTRY),
    ),
  });
  if (existing) {
    await db.update(companyTaxIdentifiers).set({ value, updatedAt: new Date() }).where(eq(companyTaxIdentifiers.id, existing.id));
  } else {
    await db.insert(companyTaxIdentifiers).values({ companyId, identifierType, value, countryCode: ZATCA_COUNTRY });
  }
}

export async function upsertZatcaTenantIdentity(companyId: string, input: UpdateZatcaTenantIdentityInput): Promise<ZatcaTenantIdentity> {
  if (input.vatNumber !== undefined) await upsertIdentifier(companyId, VAT_NUMBER_TYPE, input.vatNumber);
  if (input.commercialRegistration !== undefined) {
    await upsertIdentifier(companyId, COMMERCIAL_REGISTRATION_TYPE, input.commercialRegistration);
  }
  return getZatcaTenantIdentity(companyId);
}
