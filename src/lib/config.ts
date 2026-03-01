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

  // Acumatica
  acumaticaUrl: process.env.ACUMATICA_URL ?? "https://heritagefabrics.acumatica.com",
  acumaticaUsername: process.env.ACUMATICA_USERNAME ?? "",
  acumaticaPassword: process.env.ACUMATICA_PASSWORD ?? "",
  acumaticaTenant: process.env.ACUMATICA_TENANT ?? "",
  acumaticaBranchId: process.env.ACUMATICA_BRANCH_ID ?? "HERFAB",

  // Zoom (Server-to-Server OAuth)
  zoomAccountId: process.env.ZOOM_ACCOUNT_ID ?? "",
  zoomClientId: process.env.ZOOM_CLIENT_ID ?? "",
  zoomClientSecret: process.env.ZOOM_CLIENT_SECRET ?? "",

  // Jamf (future)
  jamfUrl: process.env.JAMF_URL ?? "",
  jamfApiKey: process.env.JAMF_API_KEY ?? "",
} as const;
