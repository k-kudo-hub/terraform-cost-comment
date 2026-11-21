/**
 * Checks that every usage line this action can produce is priced by the AWS Pricing Calculator
 * API in every supported region. Needs AWS credentials allowed to call
 * bcm-pricing-calculator:GetUsageLinesEstimatedCost. The API is free of charge.
 *
 *   npm run verify:pricing
 */
import { createAwsPricer } from "../src/pricing.js";
import { supportedRegions } from "../src/regions.js";
import { estimateUsage } from "../src/resources.js";
import type { UsageLine } from "../src/types.js";

const SAMPLES: Array<[string, Record<string, unknown>]> = [
  ["aws_instance", { instance_type: "t3.micro" }],
  ...["gp2", "st1", "sc1", "standard"].map((type): [string, Record<string, unknown>] => [
    "aws_ebs_volume",
    { type, size: 500 },
  ]),
  ["aws_ebs_volume", { type: "gp3", size: 100, iops: 4000, throughput: 250 }],
  ["aws_ebs_volume", { type: "io1", size: 100, iops: 1000 }],
  ["aws_ebs_volume", { type: "io2", size: 100, iops: 70000 }],
  ...["mysql", "postgres", "mariadb"].flatMap((engine) =>
    [false, true].flatMap((multi_az) =>
      ["gp2", "gp3", "standard"].map((storage_type): [string, Record<string, unknown>] => [
        "aws_db_instance",
        { engine, instance_class: "db.t3.micro", multi_az, allocated_storage: 20, storage_type },
      ]),
    ),
  ),
  ["aws_nat_gateway", {}],
  ...["application", "network", "gateway"].map(
    (load_balancer_type): [string, Record<string, unknown>] => ["aws_lb", { load_balancer_type }],
  ),
];

const unique = new Map<string, UsageLine>();
for (const region of supportedRegions()) {
  for (const [type, attrs] of SAMPLES) {
    for (const line of estimateUsage(type, attrs, {}, region).lines) {
      unique.set(`${line.serviceCode}|${line.usageType}|${line.operation}`, line);
    }
  }
}

/**
 * Usage types AWS does not offer in some regions (checked 2026-11-21). The action reports such
 * resources as "not estimated", so they are expected failures here.
 */
const NOT_OFFERED = [/^(APE2|APS8)-RDS:(Multi-AZ-)?StorageUsage$/];

const lines = [...unique.values()];
const result = await createAwsPricer("BEFORE_DISCOUNTS")(lines);
const notPriced = result.prices.filter((p) => p.error !== undefined);
const expected = notPriced.filter((p) => NOT_OFFERED.some((re) => re.test(p.line.usageType)));
const failed = notPriced.filter((p) => !expected.includes(p));
console.log(
  `${lines.length} usage lines checked, ${failed.length} not priced` +
    ` (${expected.length} more are not offered in their region, as expected)`,
);
for (const p of failed) {
  console.log(`  ${p.line.serviceCode} ${p.line.usageType} ${p.line.operation}: ${p.error}`);
}
process.exitCode = failed.length === 0 ? 0 : 1;
