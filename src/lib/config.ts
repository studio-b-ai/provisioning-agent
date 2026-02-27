// ─── Environment Configuration ──────────────────────────────────────

export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  logLevel: process.env.LOG_LEVEL ?? "info",

  // DRY RUN — when true, all external mutations are logged but NOT executed
  dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() === "true",

  // Connections
  databaseUrl: process.env.DATABASE_URL,

  // Microsoft Entra ID (Azure AD)
  entraClientId: process.env.ENTRA_CLIENT_ID ?? "",
  entraClientSecret: process.env.ENTRA_CLIENT_SECRET ?? "",
  entraTenantId: process.env.ENTRA_TENANT_ID ?? "",

  // GitHub
  githubOrg: process.env.GITHUB_ORG ?? "studio-b-ai",
  githubToken: process.env.GITHUB_TOKEN ?? "",

  // Slack
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  slackDeploymentsChannel: process.env.SLACK_DEPLOYMENTS_CHANNEL ?? "C0AHK777EQL",

  // HubSpot
  hubspotApiKey: process.env.HUBSPOT_API_KEY ?? "",
  hubspotPortalId: process.env.HUBSPOT_PORTAL_ID ?? "49070660",

  // Jamf (future)
  jamfUrl: process.env.JAMF_URL ?? "",
  jamfApiKey: process.env.JAMF_API_KEY ?? "",
} as const;
