import { platformApiFetch } from "./platformClient";
import type { BackupCenterStatus } from "./types";

export function getBackupStatus(): Promise<BackupCenterStatus> {
  return platformApiFetch("/platform/backup-center/status");
}
