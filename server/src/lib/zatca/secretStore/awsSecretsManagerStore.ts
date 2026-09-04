// Slice AB Scope A — production-grade ZatcaSecretStore backed by AWS
// Secrets Manager. Business code (domain/csr.ts, routes/zatca.ts) never
// imports this file or the AWS SDK directly — everything goes through the
// ZatcaSecretStore interface (types.ts), selected by secretStore/index.ts,
// exactly like DevInMemorySecretStore. AWS Secrets Manager was chosen over
// inventing a new vendor dependency: @aws-sdk/client-s3 is already a
// production dependency (Slice AA's file-storage provider), so this adds
// no new cloud vendor to the project, only a sibling client in the same
// already-adopted AWS SDK v3 family.
//
// Tenant isolation: AWS Secrets Manager has no native concept of MIDAD's
// companyId, so this store enforces it itself — every secret name is
// prefixed "midad/zatca/<companyId>/", and resolve()/delete() verify that
// prefix against the CALLER's companyId before ever touching AWS (a
// mismatched prefix returns null / no-ops without an API call at all,
// exactly like the dev store's own Map-based check). This mirrors the
// same "null means not-found OR not-yours, callers never distinguish"
// contract documented in types.ts.
//
// Private key handling: the whole ZatcaSecret object (including
// privateKeyPem) is stored as this secret's SecretString, base64/JSON
// encoded by AWS Secrets Manager's own encryption at rest — never written
// to any MIDAD database column, log line, or API response. put() returns
// only the opaque secret name as secretRef.

import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";
import { randomUUID } from "node:crypto";
import type { ZatcaSecret, ZatcaSecretStore } from "./types.js";

export interface AwsSecretsManagerZatcaStoreConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Namespaces every secret name this store creates — lets one AWS account
  // safely host secrets for multiple deployments/environments (e.g. a
  // staging vs. production MIDAD instance) without name collisions.
  // Defaults to "midad/zatca" (no leading/trailing slash needed).
  keyPrefix?: string;
}

function secretNamePrefixForCompany(keyPrefix: string, companyId: string): string {
  return `${keyPrefix}/${companyId}/`;
}

export class AwsSecretsManagerZatcaSecretStore implements ZatcaSecretStore {
  private readonly client: SecretsManagerClient;
  private readonly keyPrefix: string;

  constructor(config: AwsSecretsManagerZatcaStoreConfig) {
    this.client = new SecretsManagerClient({
      region: config.region,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
    this.keyPrefix = config.keyPrefix || "midad/zatca";
  }

  async put(companyId: string, egsUnitId: string, secret: ZatcaSecret): Promise<string> {
    const name = `${secretNamePrefixForCompany(this.keyPrefix, companyId)}${egsUnitId}/${randomUUID()}`;
    await this.client.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: JSON.stringify(secret),
      }),
    );
    return name;
  }

  async resolve(companyId: string, secretRef: string): Promise<ZatcaSecret | null> {
    // Cheap tenant check before ever calling AWS — a secretRef that does
    // not belong to this company is treated exactly like one that does
    // not exist, without granting any information (including timing) about
    // whether it exists for someone else.
    if (!secretRef.startsWith(secretNamePrefixForCompany(this.keyPrefix, companyId))) return null;

    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretRef }));
      if (!result.SecretString) return null;
      return JSON.parse(result.SecretString) as ZatcaSecret;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  async delete(companyId: string, secretRef: string): Promise<void> {
    if (!secretRef.startsWith(secretNamePrefixForCompany(this.keyPrefix, companyId))) return;
    try {
      // No ForceDeleteWithoutRecovery — AWS's default recovery window
      // (7-30 days) protects against an accidental/buggy delete call
      // permanently destroying signing-key material with no way back,
      // consistent with this codebase's general no-irreversible-deletes
      // posture elsewhere (e.g. Slice AA's storage provider never deletes
      // existing files during migration).
      await this.client.send(new DeleteSecretCommand({ SecretId: secretRef }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return;
      throw err;
    }
  }
}
