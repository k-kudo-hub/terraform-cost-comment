/**
 * Region code -> usage type prefix used by AWS billing.
 * Taken from the AWS Price List API (NatGateway-Hours usage types, 2026-11-21).
 * us-east-1 has no prefix. GovCloud (US) and China Regions are left out because
 * the Pricing Calculator API does not support them.
 */
const REGION_PREFIX: Readonly<Record<string, string>> = {
  "af-south-1": "AFS1-",
  "ap-east-1": "APE1-",
  "ap-east-2": "APE2-",
  "ap-northeast-1": "APN1-",
  "ap-northeast-2": "APN2-",
  "ap-northeast-3": "APN3-",
  "ap-south-1": "APS3-",
  "ap-south-2": "APS5-",
  "ap-southeast-1": "APS1-",
  "ap-southeast-2": "APS2-",
  "ap-southeast-3": "APS4-",
  "ap-southeast-4": "APS6-",
  "ap-southeast-5": "APS7-",
  "ap-southeast-6": "APS8-",
  "ap-southeast-7": "APS9-",
  "ca-central-1": "CAN1-",
  "ca-west-1": "CAN2-",
  "eu-central-1": "EUC1-",
  "eu-central-2": "EUC2-",
  "eu-north-1": "EUN1-",
  "eu-south-1": "EUS1-",
  "eu-south-2": "EUS2-",
  "eu-west-1": "EU-",
  "eu-west-2": "EUW2-",
  "eu-west-3": "EUW3-",
  "il-central-1": "ILC1-",
  "me-central-1": "MEC1-",
  "me-south-1": "MES1-",
  "mx-central-1": "MXC1-",
  "sa-east-1": "SAE1-",
  "us-east-1": "",
  "us-east-2": "USE2-",
  "us-west-1": "USW1-",
  "us-west-2": "USW2-",
};

export function supportedRegions(): string[] {
  return Object.keys(REGION_PREFIX);
}

/**
 * Most services bill us-east-1 usage with no prefix, but some use "USE1-" there
 * (Amazon EKS and Amazon VPC, checked in the Price List API on 2026-11-21).
 */
export type PrefixStyle = "default" | "use1";

export function usageTypePrefix(region: string, style: PrefixStyle = "default"): string {
  if (style === "use1" && region === "us-east-1") return "USE1-";
  const prefix = REGION_PREFIX[region];
  if (prefix === undefined) {
    throw new Error(
      `Region "${region}" is not supported. Supported regions: ${supportedRegions().join(", ")}`,
    );
  }
  return prefix;
}
