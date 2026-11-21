import { describe, expect, it, vi } from "vitest";
import { type RunDeps, run, upsertComment } from "../src/run.js";

const plan = {
  configuration: {
    provider_config: {
      aws: { name: "aws", expressions: { region: { constant_value: "us-east-1" } } },
    },
  },
  resource_changes: [
    {
      address: "aws_nat_gateway.main",
      type: "aws_nat_gateway",
      mode: "managed",
      change: { actions: ["create"], before: null, after: {}, after_unknown: {} },
    },
  ],
};

const deps = (over: Partial<RunDeps> = {}) => {
  const outputs: Record<string, string> = {};
  const failures: string[] = [];
  const comments: string[] = [];
  const base: RunDeps = {
    input: (name) =>
      ({ "plan-json": "plan.json", "rate-type": "BEFORE_DISCOUNTS", language: "en" })[name] ?? "",
    env: () => undefined,
    readFile: async () => JSON.stringify(plan),
    createPricer: () => async (lines) => ({ prices: lines.map((line) => ({ line, cost: 32.85 })) }),
    pullRequest: { body: "Adds a NAT gateway.\n\ncost-expectation: +10" },
    postComment: async (body) => {
      comments.push(body);
    },
    setOutput: (k, v) => {
      outputs[k] = v;
    },
    setFailed: (msg) => {
      failures.push(msg);
    },
    writeSummary: async () => {},
    info: () => {},
  };
  return { deps: { ...base, ...over }, outputs, failures, comments };
};

describe("run", () => {
  it("comments the estimate on the pull request and sets the outputs", async () => {
    const t = deps();
    await run(t.deps);
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0]).toContain("+$32.85");
    expect(t.outputs).toMatchObject({
      "monthly-delta": "32.85",
      "monthly-before": "0",
      "monthly-after": "32.85",
      unexpected: "true",
      region: "us-east-1",
    });
    expect(t.failures).toEqual([]);
  });

  it("fails the step on an unexpected increase only when asked to", async () => {
    const t = deps({
      input: (name) => ({ "plan-json": "plan.json", "fail-on-unexpected": "true" })[name] ?? "",
    });
    await run(t.deps);
    expect(t.failures[0]).toMatch(/expected/);
  });

  it("does not fail when the increase is within the expectation", async () => {
    const t = deps({
      input: (name) => ({ "plan-json": "plan.json", "fail-on-unexpected": "true" })[name] ?? "",
      pullRequest: { body: "cost-expectation: +40" },
    });
    await run(t.deps);
    expect(t.failures).toEqual([]);
    expect(t.outputs.unexpected).toBe("false");
  });

  it("prefers the aws-region input over the region in the plan", async () => {
    const t = deps({
      input: (name) => ({ "plan-json": "plan.json", "aws-region": "ap-northeast-1" })[name] ?? "",
    });
    await run(t.deps);
    expect(t.outputs.region).toBe("ap-northeast-1");
  });

  it("falls back to AWS_REGION when the plan does not name the region", async () => {
    const t = deps({
      readFile: async () => JSON.stringify({ resource_changes: [] }),
      env: (name) => (name === "AWS_REGION" ? "eu-west-1" : undefined),
    });
    await run(t.deps);
    expect(t.outputs.region).toBe("eu-west-1");
  });

  it("fails with a clear message when the region cannot be found", async () => {
    const t = deps({ readFile: async () => JSON.stringify({ resource_changes: [] }) });
    await run(t.deps);
    expect(t.failures[0]).toContain("aws-region");
  });

  it("rejects an unknown rate type", async () => {
    const t = deps({
      input: (name) => ({ "plan-json": "plan.json", "rate-type": "CHEAPEST" })[name] ?? "",
    });
    await run(t.deps);
    expect(t.failures[0]).toContain("rate-type");
  });

  it("writes only the job summary outside pull requests", async () => {
    const summary = vi.fn(async () => {});
    const t = deps({ pullRequest: undefined, writeSummary: summary });
    await run(t.deps);
    expect(t.comments).toEqual([]);
    expect(summary).toHaveBeenCalledOnce();
  });

  it("explains how to make a plan JSON when the file is not one", async () => {
    const t = deps({ readFile: async () => "Terraform will perform the following actions:" });
    await run(t.deps);
    expect(t.failures[0]).toContain("terraform show -json");
  });
});

describe("upsertComment", () => {
  const issue = { owner: "o", repo: "r", issue_number: 1 };

  it("updates the comment that carries the marker", async () => {
    const api = {
      listComments: vi.fn(async () => [
        { id: 1, body: "unrelated", user: { type: "Bot" } },
        { id: 2, body: "<!-- terraform-cost-comment -->\nold", user: { type: "Bot" } },
      ]),
      createComment: vi.fn(),
      updateComment: vi.fn(),
    };
    await upsertComment(api, issue, "<!-- terraform-cost-comment -->", "new");
    expect(api.updateComment).toHaveBeenCalledWith({
      owner: "o",
      repo: "r",
      comment_id: 2,
      body: "new",
    });
    expect(api.createComment).not.toHaveBeenCalled();
  });

  it("leaves a person's comment that starts with the marker alone", async () => {
    const api = {
      listComments: vi.fn(async () => [
        { id: 3, body: "<!-- terraform-cost-comment -->\nquoted", user: { type: "User" } },
      ]),
      createComment: vi.fn(),
      updateComment: vi.fn(),
    };
    await upsertComment(api, issue, "<!-- terraform-cost-comment -->", "new");
    expect(api.updateComment).not.toHaveBeenCalled();
    expect(api.createComment).toHaveBeenCalledOnce();
  });

  it("creates a comment when none carries the marker", async () => {
    const api = {
      listComments: vi.fn(async () => [{ id: 1, body: "<!-- terraform-cost-comment:prod -->" }]),
      createComment: vi.fn(),
      updateComment: vi.fn(),
    };
    await upsertComment(api, issue, "<!-- terraform-cost-comment -->", "new");
    expect(api.createComment).toHaveBeenCalledWith({ ...issue, body: "new" });
  });
});
