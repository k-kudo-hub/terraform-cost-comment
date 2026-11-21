import type { Pricer } from "./pricing.js";
import { estimateUsage, isAwsType } from "./resources.js";
import type { Attributes, UsageLine } from "./types.js";

/** The parts of `terraform show -json <planfile>` this action reads. */
export interface TerraformPlan {
  resource_changes?: ResourceChange[];
  variables?: Record<string, { value?: unknown }>;
  configuration?: {
    provider_config?: Record<
      string,
      {
        name?: string;
        expressions?: { region?: { constant_value?: unknown; references?: string[] } };
      }
    >;
  };
}

export interface ResourceChange {
  address: string;
  type: string;
  mode?: string;
  change: {
    actions: string[];
    before?: Attributes | null;
    after?: Attributes | null;
    after_unknown?: Attributes | null;
  };
}

export type Action = "create" | "delete" | "update" | "replace";

export interface ResourceEstimate {
  address: string;
  type: string;
  action: Action;
  /** Monthly cost before the change, in USD. */
  before: number;
  /** Monthly cost after the change, in USD. */
  after: number;
  delta: number;
  /** Usage lines priced after the change (or before, for deletions). */
  lines: Array<UsageLine & { cost: number }>;
  excluded: string[];
  /** Parts that would cost money but could not be priced, before or after the change. */
  partial: string[];
}

export interface NotEstimated {
  address: string;
  type: string;
  action: Action;
  reason: string;
}

export interface PlanEstimate {
  resources: ResourceEstimate[];
  /** Changed AWS resources that could not be estimated at all. */
  notEstimated: NotEstimated[];
  /** Number of changed resources of other providers (random, null, tls ...), not priced. */
  otherProviderCount: number;
  totalBefore: number;
  totalAfter: number;
  totalDelta: number;
}

function toAction(actions: string[]): Action | undefined {
  if (actions.includes("create") && actions.includes("delete")) return "replace";
  if (actions.includes("create")) return "create";
  if (actions.includes("delete")) return "delete";
  if (actions.includes("update")) return "update";
  return undefined;
}

interface Pending {
  change: ResourceChange;
  action: Action;
  before: UsageLine[];
  after: UsageLine[];
  excluded: string[];
  partial: string[];
}

/** Round to a hundredth of a cent so float noise does not show up as a change. */
const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Estimates how the monthly cost changes when the plan is applied.
 * Resources that change but cannot be estimated are listed in `notEstimated`, never dropped.
 */
export async function estimatePlan(
  plan: TerraformPlan,
  region: string,
  pricer: Pricer,
): Promise<PlanEstimate> {
  const pending: Pending[] = [];
  const notEstimated: NotEstimated[] = [];
  let otherProviderCount = 0;

  for (const rc of plan.resource_changes ?? []) {
    if (rc.mode !== undefined && rc.mode !== "managed") continue;
    const action = toAction(rc.change.actions);
    if (action === undefined) continue;
    if (!isAwsType(rc.type)) {
      otherProviderCount += 1;
      continue;
    }
    const sides = {
      before:
        action === "create"
          ? undefined
          : estimateUsage(rc.type, rc.change.before ?? {}, {}, region),
      after:
        action === "delete"
          ? undefined
          : estimateUsage(rc.type, rc.change.after ?? {}, rc.change.after_unknown ?? {}, region),
    };
    const reason = sides.after?.unestimable ?? sides.before?.unestimable;
    if (reason !== undefined) {
      notEstimated.push({ address: rc.address, type: rc.type, action, reason });
      continue;
    }
    pending.push({
      change: rc,
      action,
      before: sides.before?.lines ?? [],
      after: sides.after?.lines ?? [],
      excluded: [...new Set([...(sides.before?.excluded ?? []), ...(sides.after?.excluded ?? [])])],
      partial: [
        ...(sides.before?.partial ?? []).map((x) => `before the change: ${x}`),
        ...(sides.after?.partial ?? []),
      ],
    });
  }

  const allLines = pending.flatMap((p) => [...p.before, ...p.after]);
  const { prices } = await pricer(allLines);

  const resources: ResourceEstimate[] = [];
  let offset = 0;
  for (const p of pending) {
    const take = (n: number) => {
      const slice = prices.slice(offset, offset + n);
      offset += n;
      return slice;
    };
    const before = take(p.before.length);
    const after = take(p.after.length);
    const failed = [...before, ...after].find((x) => x.cost === undefined);
    if (failed !== undefined) {
      notEstimated.push({
        address: p.change.address,
        type: p.change.type,
        action: p.action,
        reason: `AWS could not price ${failed.line.usageType} / ${failed.line.operation} (${failed.error})`,
      });
      continue;
    }
    const sum = (xs: typeof before) => round(xs.reduce((s, x) => s + (x.cost ?? 0), 0));
    const b = sum(before);
    const a = sum(after);
    const shown = p.action === "delete" ? before : after;
    resources.push({
      address: p.change.address,
      type: p.change.type,
      action: p.action,
      before: b,
      after: a,
      delta: round(a - b),
      lines: shown.map((x) => ({ ...x.line, cost: x.cost ?? 0 })),
      excluded: p.excluded,
      partial: p.partial,
    });
  }

  resources.sort((x, y) => y.delta - x.delta);
  const totalBefore = round(resources.reduce((s, r) => s + r.before, 0));
  const totalAfter = round(resources.reduce((s, r) => s + r.after, 0));
  return {
    resources,
    notEstimated,
    otherProviderCount,
    totalBefore,
    totalAfter,
    totalDelta: round(totalAfter - totalBefore),
  };
}

/** Reads the region of the default aws provider from the plan, when it is written there. */
export function detectRegion(plan: TerraformPlan): string | undefined {
  const config = plan.configuration?.provider_config?.aws;
  const region = config?.expressions?.region;
  if (typeof region?.constant_value === "string") return region.constant_value;
  const ref = region?.references?.find((r) => r.startsWith("var."));
  if (ref !== undefined) {
    const value = plan.variables?.[ref.slice("var.".length)]?.value;
    if (typeof value === "string") return value;
  }
  return undefined;
}
