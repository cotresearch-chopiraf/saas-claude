// No email provider is wired up yet (needs a Resend/SendGrid API key — an
// external dependency, see README). Until then, "sending" an email logs the
// link to the server console so the flow is fully testable end-to-end.
export function sendMail(to: string, subject: string, body: string): void {
  console.log(`\n--- [DEV MAIL] to=${to} subject="${subject}" ---\n${body}\n---\n`);
}
