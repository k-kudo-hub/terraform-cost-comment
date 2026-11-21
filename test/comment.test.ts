import { describe, expect, it } from "vitest";
import { judge, parseExpectation, renderComment } from "../src/comment.js";
import type { PlanEstimate, ResourceEstimate } from "../src/estimate.js";

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
      description: "NAT gateway (730 h)",
      cost: 45.26,
    },
  ],
  excluded: ["NAT gateway data processing (per GB)"],
  ...over,
});

const estimate = (over: Partial<PlanEstimate> = {}): PlanEstimate => ({
  resources: [resource({})],
  notEstimated: [],
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
            reason: "resource type aws_s3_bucket is not supported",
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

  it("writes Japanese when asked", () => {
    const body = renderComment(estimate(), 10, { ...ctx, language: "ja" });
    expect(body).toContain("月額");
    expect(body).toContain("想定");
  });
});
