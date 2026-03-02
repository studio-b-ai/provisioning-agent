#!/usr/bin/env tsx
/**
 * Creates all 10 custom ticket properties for the Employee Onboarding pipeline.
 * Skips any that already exist (409 = already exists).
 *
 * Usage:
 *   npx tsx scripts/create-hubspot-properties.ts
 *
 * Requires:
 *   HUBSPOT_ACCESS_TOKEN env var (or uses the default from acumatica-hubspot-sync)
 */

const HUBSPOT_TOKEN =
  process.env.HUBSPOT_ACCESS_TOKEN ??
  "pat-na1-d2145898-5090-4b24-b1d7-10f472d9499c";

const API_BASE = "https://api.hubapi.com/crm/v3/properties/tickets";

interface PropertyDef {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
  description: string;
  options?: Array<{ label: string; value: string; displayOrder: number }>;
}

const properties: PropertyDef[] = [
  {
    name: "employee_email",
    label: "Employee Email",
    type: "string",
    fieldType: "text",
    groupName: "ticketinformation",
    description: "Email address of the employee being onboarded/offboarded",
  },
  {
    name: "employee_first_name",
    label: "Employee First Name",
    type: "string",
    fieldType: "text",
    groupName: "ticketinformation",
    description: "First name of the employee being onboarded/offboarded",
  },
  {
    name: "employee_last_name",
    label: "Employee Last Name",
    type: "string",
    fieldType: "text",
    groupName: "ticketinformation",
    description: "Last name of the employee being onboarded/offboarded",
  },
  {
    name: "employee_department",
    label: "Employee Department",
    type: "enumeration",
    fieldType: "select",
    groupName: "ticketinformation",
    description: "Department for the employee being onboarded",
    options: [
      { label: "Admin", value: "ADMIN", displayOrder: 0 },
      { label: "Sales", value: "SALES", displayOrder: 1 },
      { label: "Warehouse", value: "WAREHOUSE", displayOrder: 2 },
      { label: "Design", value: "DESIGN", displayOrder: 3 },
      { label: "Finance", value: "FINANCE", displayOrder: 4 },
    ],
  },
  {
    name: "employee_job_title",
    label: "Employee Job Title",
    type: "string",
    fieldType: "text",
    groupName: "ticketinformation",
    description: "Job title for the employee being onboarded",
  },
  {
    name: "employee_start_date",
    label: "Employee Start Date",
    type: "date",
    fieldType: "date",
    groupName: "ticketinformation",
    description: "Planned start date for the new employee",
  },
  {
    name: "employee_phone",
    label: "Employee Phone",
    type: "string",
    fieldType: "text",
    groupName: "ticketinformation",
    description: "Phone number for the employee being onboarded",
  },
  {
    name: "employee_github_username",
    label: "Employee GitHub Username",
    type: "string",
    fieldType: "text",
    groupName: "ticketinformation",
    description: "GitHub username for the employee (optional)",
  },
  {
    name: "provisioning_run_id",
    label: "Provisioning Run ID",
    type: "number",
    fieldType: "number",
    groupName: "ticketinformation",
    description: "ID of the provisioning-agent run linked to this ticket",
  },
  {
    name: "provisioning_status",
    label: "Provisioning Status",
    type: "enumeration",
    fieldType: "select",
    groupName: "ticketinformation",
    description: "Current status of the provisioning workflow",
    options: [
      { label: "Pending", value: "pending", displayOrder: 0 },
      { label: "Running", value: "running", displayOrder: 1 },
      { label: "Success", value: "success", displayOrder: 2 },
      { label: "Partial", value: "partial", displayOrder: 3 },
      { label: "Failed", value: "failed", displayOrder: 4 },
    ],
  },
];

async function createProperty(prop: PropertyDef): Promise<string> {
  const res = await fetch(API_BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${HUBSPOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(prop),
  });

  if (res.status === 409) {
    return "already exists";
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `FAILED (${res.status}): ${body.slice(0, 200)}`;
  }

  const data = (await res.json()) as { name: string };
  return `created â ${data.name}`;
}

async function main() {
  console.log("\nââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ");
  console.log("â  HubSpot â Create Employee Onboarding Ticket Properties  â");
  console.log("ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ\n");

  let created = 0;
  let existing = 0;
  let failed = 0;

  for (const prop of properties) {
    const result = await createProperty(prop);
    const icon =
      result === "already exists" ? "â­ï¸" :
      result.startsWith("created") ? "â" : "â";

    console.log(`  ${icon} ${prop.label.padEnd(28)} ${result}`);

    if (result === "already exists") existing++;
    else if (result.startsWith("created")) created++;
    else failed++;
  }

  console.log(`\n${"â".repeat(60)}`);
  console.log(`  Created: ${created} | Already existed: ${existing} | Failed: ${failed}`);
  console.log(`${"â".repeat(60)}\n`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
