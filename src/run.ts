import type { RateType } from "@aws-sdk/client-bcm-pricing-calculator";
import {
  gaps,
  isUnexpected,
  judge,
  type Language,
  marker,
  parseExpectation,
  renderComment,
} from "./comment.js";
import { detectRegion, estimatePlan, type TerraformPlan } from "./estimate.js";
import { type Pricer, RATE_TYPES } from "./pricing.js";
import { usageTypePrefix } from "./regions.js";

/** Everything the action touches outside itself, so it can be tested without GitHub or AWS. */
export interface RunDeps {
  input(name: string): string;
  /** Environment variable, for the region set by aws-actions/configure-aws-credentials. */
  env(name: string): string | undefined;
  readFile(path: string): Promise<string>;
  createPricer(rateType: RateType): Pricer;
  /** Set when the workflow runs for a pull request. */
  pullRequest: { body?: string | null } | undefined;
  postComment(body: string, marker: string): Promise<void>;
  setOutput(name: string, value: string): void;
  setFailed(message: string): void;
  writeSummary(body: string): Promise<void>;
  info(message: string): void;
}

const LANGUAGES: readonly Language[] = ["en", "ja"];

function parsePlan(text: string, path: string): TerraformPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `${path} is not JSON. Pass the output of \`terraform show -json <planfile>\` as plan-json.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a Terraform plan. Use \`terraform show -json <planfile>\`.`);
  }
  return parsed as TerraformPlan;
}

export async function run(deps: RunDeps): Promise<void> {
  try {
    const planPath = deps.input("plan-json");
    if (planPath === "") throw new Error("Input plan-json is required.");

    const rateType = (deps.input("rate-type") || "BEFORE_DISCOUNTS") as RateType;
    if (!RATE_TYPES.includes(rateType)) {
      throw new Error(
        `Input rate-type must be one of ${RATE_TYPES.join(", ")}, got "${rateType}".`,
      );
    }
    const language = (deps.input("language") || "en") as Language;
    if (!LANGUAGES.includes(language)) {
      throw new Error(`Input language must be one of ${LANGUAGES.join(", ")}, got "${language}".`);
    }
    const tag = deps.input("comment-tag");
    const failOnUnexpected = deps.input("fail-on-unexpected") === "true";

    const plan = parsePlan(await deps.readFile(planPath), planPath);
    const region =
      deps.input("aws-region") ||
      detectRegion(plan) ||
      deps.env("AWS_REGION") ||
      deps.env("AWS_DEFAULT_REGION");
    if (region === undefined) {
      throw new Error(
        "Could not find the AWS region in the plan or in AWS_REGION. Set the aws-region input.",
      );
    }
    usageTypePrefix(region); // fails early on an unsupported region

    const estimate = await estimatePlan(plan, region, deps.createPricer(rateType));
    const expected = parseExpectation(deps.pullRequest?.body);
    const verdict = judge(estimate.totalDelta, expected);
    const body = renderComment(estimate, expected, { region, rateType, tag, language });

    deps.setOutput("monthly-delta", String(estimate.totalDelta));
    deps.setOutput("monthly-before", String(estimate.totalBefore));
    deps.setOutput("monthly-after", String(estimate.totalAfter));
    deps.setOutput("unexpected", String(isUnexpected(verdict)));
    deps.setOutput("not-estimated-count", String(gaps(estimate).length));
    deps.setOutput("region", region);

    await deps.writeSummary(body);
    if (deps.pullRequest !== undefined) {
      await deps.postComment(body, marker(tag));
    } else {
      deps.info("Not a pull request event; wrote the estimate to the job summary only.");
    }

    if (failOnUnexpected && isUnexpected(verdict)) {
      deps.setFailed(
        verdict.kind === "exceeded"
          ? `The monthly cost increase exceeds the expected change by $${verdict.over.toFixed(2)}.`
          : "The monthly cost increases but the PR description declares no expected change (cost-expectation).",
      );
    }
  } catch (error) {
    deps.setFailed(error instanceof Error ? error.message : String(error));
  }
}

/** The GitHub REST calls `upsertComment` needs. */
export interface CommentApi {
  listComments(issue: {
    owner: string;
    repo: string;
    issue_number: number;
  }): Promise<Array<{ id: number; body?: string | null; user?: { type?: string } | null }>>;
  createComment(params: {
    owner: string;
    repo: string;
    issue_number: number;
    body: string;
  }): Promise<unknown>;
  updateComment(params: {
    owner: string;
    repo: string;
    comment_id: number;
    body: string;
  }): Promise<unknown>;
}

/** Updates this action's earlier comment on the PR, or creates one, so the PR keeps one estimate. */
export async function upsertComment(
  api: CommentApi,
  issue: { owner: string; repo: string; issue_number: number },
  commentMarker: string,
  body: string,
): Promise<void> {
  const comments = await api.listComments(issue);
  // Only bot comments: the default token posts as github-actions[bot] and cannot edit people's comments.
  const existing = comments.findLast(
    (c) => c.user?.type === "Bot" && c.body?.split("\n", 1)[0] === commentMarker,
  );
  if (existing !== undefined) {
    await api.updateComment({
      owner: issue.owner,
      repo: issue.repo,
      comment_id: existing.id,
      body,
    });
  } else {
    await api.createComment({ ...issue, body });
  }
}
