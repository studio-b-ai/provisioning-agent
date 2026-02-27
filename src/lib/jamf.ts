/**
 * Jamf Pro enrollment invitation stub — DRY_RUN only for now.
 * Full implementation pending Jamf Pro configuration.
 */

import pino from "pino";
import { config } from "./config.js";

const logger = pino({ level: config.logLevel });

export async function sendEnrollmentInvitation(email: string, deviceType: string = "mac"): Promise<boolean> {
  if (config.dryRun || !config.jamfUrl) {
    logger.info(
      { action: "sendEnrollmentInvitation", email, deviceType, dryRun: true },
      "[DRY RUN] Would send Jamf enrollment invitation"
    );
    return true;
  }

  // Future: Jamf Pro API call to send enrollment invitation
  // POST /api/v1/device-enrollments/
  logger.warn({ email, deviceType }, "Jamf enrollment not implemented — requires Jamf Pro setup");
  return false;
}

export async function wipeDevice(serialNumber: string): Promise<boolean> {
  if (config.dryRun || !config.jamfUrl) {
    logger.info(
      { action: "wipeDevice", serialNumber, dryRun: true },
      "[DRY RUN] Would initiate remote wipe"
    );
    return true;
  }

  logger.warn({ serialNumber }, "Jamf device wipe not implemented — requires Jamf Pro setup");
  return false;
}

export function isConfigured(): boolean {
  return !!(config.jamfUrl && config.jamfApiKey);
}
