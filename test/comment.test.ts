import { describe, expect, it } from "vitest";
import { judge, parseExpectation, renderComment } from "../src/comment.js";
import type { PlanEstimate, ResourceEstimate } from "../src/estimate.js";
import { same } from "./helpers.js";

const resource = (over: Partial<ResourceEstimate>): ResourceEstimate => ({
  address: "aws_nat_gateway.main",
  type: "aws_nat_gateway",
  action: "create",
  before: 0,
  after: 45.26,
  delta: 45.26,
  lines: [
    {
      serviceCode: "AmazonEC2",
      usageType: "APN1-NatGateway-Hours",
      operation: "NatGateway",
      amount: 730,
      description: same("NAT gateway (730 h)"),
      cost: 45.26,
    },
  ],
  excluded: [same("NAT gateway data processing (per GB)")],
  partial: [],
  ...over,
});

const estimate = (over: Partial<PlanEstimate> = {}): PlanEstimate => ({
  resources: [resource({})],
  notEstimated: [],
  otherProviderCount: 0,
  totalBefore: 0,
  totalAfter: 45.26,
  totalDelta: 45.26,
  ...over,
});

const ctx = { region: "ap-northeast-1", rateType: "BEFORE_DISCOUNTS", tag: "" } as const;

describe("parseExpectation", () => {
  it("reads the expected monthly change the PR author wrote", () => {
    expect(parseExpectation("Adds a NAT gateway.\n\ncost-expectation: +50\n")).toBe(50);
    expect(parseExpectation("cost-expectation: $12.5")).toBe(12.5);
    expect(parseExpectation("Cost-Expectation: -20")).toBe(-20);
    expect(parseExpectation("cost-expectation: 0")).toBe(0);
  });

  it("returns undefined when nothing is declared", () => {
    expect(parseExpectation("")).toBeUndefined();
    expect(parseExpectation(undefined)).toBeUndefined();
    expect(parseExpectation("cost-expectation: lots")).toBeUndefined();
  });
});

describe("judge", () => {
  it("is within when the increase does not exceed the expectation", () => {
    expect(judge(45.26, 50)).toEqual({ kind: "within", expected: 50 });
  });

  it("is exceeded when the increase is larger than the expectation", () => {
    expect(judge(45.26, 10)).toEqual({ kind: "exceeded", expected: 10, over: 35.26 });
  });

  it("asks for an expectation when cost goes up and none is declared", () => {
    expect(judge(45.26, undefined)).toEqual({ kind: "undeclared" });
  });

  it("ignores differences below a cent", () => {
    expect(judge(0.001, 0)).toEqual({ kind: "within", expected: 0 });
    expect(judge(0.004, undefined)).toEqual({ kind: "no-increase" });
  });

  it("needs no expectation when cost does not go up", () => {
    expect(judge(-3, undefined)).toEqual({ kind: "no-increase" });
    expect(judge(0, undefined)).toEqual({ kind: "no-increase" });
  });
});

describe("renderComment", () => {
  it("puts the total change in the headline and a hidden marker to find the comment later", () => {
    const body = renderComment(estimate(), undefined, { ...ctx, language: "en" });
    expect(body.startsWith("<!-- terraform-cost-comment -->")).toBe(true);
    expect(body).toContain("+$45.26");
    expect(body).toContain("`aws_nat_gateway.main`");
  });

  it("separates comments of different plans by tag", () => {
    const body = renderComment(estimate(), undefined, { ...ctx, tag: "prod", language: "en" });
    expect(body.startsWith("<!-- terraform-cost-comment:prod -->")).toBe(true);
  });

  it("warns when the increase exceeds what the PR author expected", () => {
    const body = renderComment(estimate(), 10, { ...ctx, language: "en" });
    expect(body).toContain("[!WARNING]");
    expect(body).toContain("+$10.00");
    expect(body).toContain("$35.26");
  });

  it("asks the PR author to declare an expectation when none is declared", () => {
    const body = renderComment(estimate(), undefined, { ...ctx, language: "en" });
    expect(body).toContain("cost-expectation: +");
  });

  it("shows changed resources it could not estimate, so the total is not mistaken for complete", () => {
    const body = renderComment(
      estimate({
        notEstimated: [
          {
            address: "aws_s3_bucket.logs",
            type: "aws_s3_bucket",
            action: "create",
            reason: same("resource type aws_s3_bucket is not supported"),
          },
        ],
      }),
      50,
      { ...ctx, language: "en" },
    );
    expect(body).toContain("`aws_s3_bucket.logs`");
    expect(body).toContain("resource type aws_s3_bucket is not supported");
    expect(body).toMatch(/not included/i);
  });

  it("lists what the estimate leaves out and the assumptions", () => {
    const body = renderComment(estimate(), 50, { ...ctx, language: "en" });
    expect(body).toContain("NAT gateway data processing (per GB)");
    expect(body).toContain("730");
    expect(body).toContain("ap-northeast-1");
  });

  it("says so when the plan does not change cost", () => {
    const body = renderComment(
      estimate({ resources: [], totalAfter: 0, totalDelta: 0 }),
      undefined,
      { ...ctx, language: "en" },
    );
    expect(body).toContain("$0.00");
    expect(body).not.toContain("| Resource |");
  });

  it("separates thousands in amounts", () => {
    const body = renderComment(estimate({ totalAfter: 1346.6, totalDelta: 1346.6 }), undefined, {
      ...ctx,
      language: "en",
    });
    expect(body).toContain("+$1,346.60");
  });

  it("never says the cost does not increase when something is not estimated", () => {
    const body = renderComment(
      estimate({
        resources: [],
        totalAfter: 0,
        totalDelta: 0,
        notEstimated: [
          {
            address: "aws_rds_cluster.main",
            type: "aws_rds_cluster",
            action: "create",
            reason: same("resource type aws_rds_cluster is not supported"),
          },
        ],
      }),
      undefined,
      { ...ctx, language: "en" },
    );
    expect(body).not.toContain("✅");
    expect(body).not.toContain("No resource in this plan changes the monthly cost");
    expect(body).toContain("`aws_rds_cluster.main`");
  });

  it("does not put a check mark on a within verdict when something is not estimated", () => {
    const body = renderComment(
      estimate({
        resources: [resource({ partial: [same("root volume size is not known until apply")] })],
      }),
      100,
      { ...ctx, language: "en" },
    );
    expect(body).not.toContain("✅");
  });

  it("lists unpriced parts next to their resource and counts them", () => {
    const body = renderComment(
      estimate({
        resources: [
          resource({
            address: "aws_db_instance.db",
            partial: [same("io2 storage and its provisioned IOPS are not supported")],
          }),
        ],
      }),
      100,
      { ...ctx, language: "en" },
    );
    expect(body).toContain("1 change is not included");
    expect(body).toMatch(
      /\| `aws_db_instance\.db` \| create \| io2 storage and its provisioned IOPS are not supported \|/,
    );
  });

  it("says the cost goes down less than expected instead of calling it an increase", () => {
    const body = renderComment(estimate({ totalBefore: 10, totalAfter: 5, totalDelta: -5 }), -20, {
      ...ctx,
      language: "en",
    });
    expect(body).toContain("[!WARNING]");
    expect(body).toContain("less");
    expect(body).not.toContain("increase is intended");
  });

  it("mentions non-AWS resources only as a count in the footnote", () => {
    const body = renderComment(estimate({ otherProviderCount: 3 }), 100, {
      ...ctx,
      language: "en",
    });
    expect(body).toContain("3 changed resources of non-AWS providers");
    expect(body).not.toContain("[!CAUTION]");
  });

  it("leaves resources with nothing priced out of the table", () => {
    const body = renderComment(
      estimate({
        resources: [
          resource({}),
          resource({
            address: "aws_vpc_endpoint.s3",
            type: "aws_vpc_endpoint",
            after: 0,
            delta: 0,
            lines: [],
            excluded: [],
          }),
        ],
      }),
      100,
      { ...ctx, language: "en" },
    );
    expect(body).not.toContain("aws_vpc_endpoint.s3");
  });

  it("writes Japanese when asked", () => {
    const body = renderComment(estimate(), 10, { ...ctx, language: "ja" });
    expect(body).toContain("月額");
    expect(body).toContain("想定");
  });
});
