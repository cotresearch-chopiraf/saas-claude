// NON-PRODUCTION ZatcaSecretStore (Slice 3). Secret material lives only in
// this process's own memory — nothing here is ever written to disk, a
// database column, a log line, or git. It dies with the process (a
// restart loses every stored secret), which is intentional: this is a
// development/test convenience, not durable storage, and must never be
// selected for a real deployment.
//
// A real ZatcaSecretStore (AWS Secrets Manager, Azure Key Vault, HashiCorp
// Vault, or similar) is a separate infrastructure decision this slice does
// not make — MIDAD must not auto-select a cloud provider just because its
// credentials happen to be present in the coding environment (see the
// Slice 3 prompt's STEP 20). When that decision is made, its implementation
// is a second class satisfying the same ZatcaSecretStore interface —
// nothing outside secretStore/ needs to change.

import { randomUUID } from "node:crypto";
import type { ZatcaSecret, ZatcaSecretStore } from "./types.js";

interface StoredEntry {
  companyId: string;
  secret: ZatcaSecret;
}

export class DevInMemorySecretStore implements ZatcaSecretStore {
  private readonly entries = new Map<string, StoredEntry>();

  async put(companyId: string, egsUnitId: string, secret: ZatcaSecret): Promise<string> {
    const secretRef = `dev:${egsUnitId}:${randomUUID()}`;
    this.entries.set(secretRef, { companyId, secret });
    return secretRef;
  }

  async resolve(companyId: string, secretRef: string): Promise<ZatcaSecret | null> {
    const entry = this.entries.get(secretRef);
    if (!entry || entry.companyId !== companyId) return null;
    return entry.secret;
  }

  async delete(companyId: string, secretRef: string): Promise<void> {
    const entry = this.entries.get(secretRef);
    if (entry && entry.companyId === companyId) this.entries.delete(secretRef);
  }
}
