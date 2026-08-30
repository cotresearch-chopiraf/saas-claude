import { platformApiFetch } from "./platformClient";
import type { PlatformOperator } from "./types";

export function platformLogin(email: string, password: string): Promise<{ token: string; operator: PlatformOperator }> {
  return platformApiFetch("/platform/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}
