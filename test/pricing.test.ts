import type { GetUsageLinesEstimatedCostCommand } from "@aws-sdk/client-bcm-pricing-calculator";
import { describe, expect, it, vi } from "vitest";
import { createAwsPricer } from "../src/pricing.js";
import type { UsageLine } from "../src/types.js";

const line = (i: number): UsageLine => ({
  serviceCode: "AmazonEC2",
  usageType: `BoxUsage:t${i}`,
  operation: "RunInstances",
  amount: 730,
  description: `line ${i}`,
});

type Cmd = GetUsageLinesEstimatedCostCommand;
const usageOf = (cmd: Cmd) => cmd.input.usage ?? [];

describe("createAwsPricer", () => {
  it("returns the cost of each line and keeps the input order", async () => {
    const send = vi.fn(async (cmd: Cmd) => ({
      currency: "USD",
      lineItems: usageOf(cmd)
        .map((u, i) => ({ key: u.key, estimatedCost: { cost: i + 1, currency: "USD" } }))
        .reverse(),
      errors: [],
    }));
    const prices = await createAwsPricer("BEFORE_DISCOUNTS", { send })([line(0), line(1)]);
    expect(prices.prices.map((p) => p.cost)).toEqual([1, 2]);
    expect(send.mock.calls[0]?.[0].input.rateType).toBe("BEFORE_DISCOUNTS");
  });

  it("splits more than 500 lines into several requests", async () => {
    // The fake prices each line by the number in its usage type, so a mix-up shows.
    const send = vi.fn(async (cmd: Cmd) => ({
      lineItems: usageOf(cmd)
        .map((u) => ({
          key: u.key,
          estimatedCost: { cost: Number(u.usageType?.replace(/\D/g, "")) },
        }))
        .reverse(),
    }));
    const lines = Array.from({ length: 1201 }, (_, i) => line(i));
    const result = await createAwsPricer("BEFORE_DISCOUNTS", { send })(lines);
    expect(send.mock.calls.map((c) => usageOf(c[0]).length)).toEqual([500, 500, 201]);
    expect(result.prices).toHaveLength(1201);
    expect(result.prices.map((p) => p.cost)).toEqual(lines.map((_, i) => i));
    for (const call of send.mock.calls) {
      for (const u of usageOf(call[0])) expect(u.key).toMatch(/^[a-zA-Z0-9]{1,10}$/);
    }
  });

  it("reports lines the API could not price", async () => {
    const send = vi.fn(async (cmd: Cmd) => ({
      lineItems: [{ key: usageOf(cmd)[0]?.key, estimatedCost: { cost: 5 } }],
      errors: [
        {
          key: usageOf(cmd)[1]?.key,
          errorCode: "BAD_REQUEST",
          errorMessage: "No matching usage",
        },
      ],
    }));
    const result = await createAwsPricer("BEFORE_DISCOUNTS", { send })([line(0), line(1), line(2)]);
    expect(result.prices.map((p) => [p.cost, p.error])).toEqual([
      [5, undefined],
      [undefined, "BAD_REQUEST: No matching usage"],
      [undefined, "the API returned no price for this line"],
    ]);
  });

  it("does not call the API when there is nothing to price", async () => {
    const send = vi.fn();
    const result = await createAwsPricer("BEFORE_DISCOUNTS", { send })([]);
    expect(result.prices).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
});
