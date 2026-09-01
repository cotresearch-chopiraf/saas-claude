// Tenant-scoped secret storage abstraction (Slice 3). The database
// (zatca_egs_units.secret_ref) only ever holds the opaque string this
// interface's put() returns — never the credential material itself. See
// devSecretStore.ts for the only implementation that currently exists,
// and its own file comment for why it must never be used in production.

export interface ZatcaSecret {
  // ZATCA's own terminology: the X.509 certificate issued during CSID
  // onboarding, and its paired secret.
  binarySecurityToken: string;
  secret: string;
  // Slice 5 continuation — the ECDSA private key MIDAD generated locally
  // (lib/zatca/csr/keyPair.ts) during CSR/CSID onboarding, and the curve
  // it's on. Optional: a credential connected via the older manual
  // "connect credentials" form (routes/zatca.ts's POST .../credential)
  // never has one, and real XAdES signing refuses to run without it (see
  // signer/xadesZatcaSigner.ts) rather than fabricate a signature. Never
  // logged, never returned from an API route — this interface's whole
  // point is keeping this out of any plaintext DB column.
  privateKeyPem?: string;
  curve?: string;
  // Set only transiently, between CSR generation and CSID confirmation
  // (domain/csr.ts) — lets confirmCsidForEgsUnit() verify the certificate
  // ZATCA issued actually matches the key pair MIDAD generated for the
  // CSR, before ever storing it as this EGS unit's active credential.
  // Cleared (not carried forward) once CSID is confirmed — a public key
  // is not secret, but there is no reason to keep it once its one job is
  // done.
  publicKeyPem?: string;
}

export interface ZatcaSecretStore {
  // Stores secret material for a tenant's EGS unit and returns an opaque
  // reference to persist in zatca_egs_units.secret_ref. A second put() for
  // the same egsUnitId (re-onboarding, credential rotation) returns a new,
  // different reference — callers are responsible for updating the stored
  // secretRef and may separately delete() the old one.
  put(companyId: string, egsUnitId: string, secret: ZatcaSecret): Promise<string>;

  // Resolves a secretRef back to usable credential material, scoped to
  // companyId. Returns null both when the ref doesn't exist AND when it
  // belongs to a different company — callers must never distinguish those
  // two cases, the same tenant-isolation contract as every
  // findOwned*()/getEgsUnit()-style helper in domain/.
  resolve(companyId: string, secretRef: string): Promise<ZatcaSecret | null>;

  // No-op if the ref doesn't exist or belongs to a different company.
  delete(companyId: string, secretRef: string): Promise<void>;
}
