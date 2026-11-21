import type { Action, PlanEstimate } from "./estimate.js";
import { HOURS_PER_MONTH } from "./resources.js";

export type Language = "en" | "ja";

export interface RenderContext {
  region: string;
  rateType: string;
  /** Distinguishes comments of several plans on one PR. Empty for a single plan. */
  tag: string;
  language: Language;
}

/**
 * The PR author's expected monthly change, written in the PR description as
 * `cost-expectation: +50` (USD per month).
 */
export function parseExpectation(body: string | null | undefined): number | undefined {
  const m = /^\s*cost-expectation:\s*([+-]?)\s*\$?\s*(\d+(?:\.\d+)?)\s*$/im.exec(body ?? "");
  if (m === null) return undefined;
  const value = Number(m[2]);
  return m[1] === "-" ? -value : value;
}

export type Verdict =
  | { kind: "within"; expected: number }
  | { kind: "exceeded"; expected: number; over: number }
  | { kind: "undeclared" }
  | { kind: "no-increase" };

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * Compares the estimated change with what the PR author expected. A PR author usually expects
 * some increase; what costs money is an increase nobody expected. Compared in whole cents so
 * float noise never raises a warning.
 */
export function judge(delta: number, expected: number | undefined): Verdict {
  const d = cents(delta);
  if (expected === undefined) return d > 0 ? { kind: "undeclared" } : { kind: "no-increase" };
  if (d > expected) return { kind: "exceeded", expected, over: cents(d - expected) };
  return { kind: "within", expected };
}

/** Whether the estimated change is one nobody declared they expected. */
export function isUnexpected(verdict: Verdict): boolean {
  return verdict.kind === "exceeded" || verdict.kind === "undeclared";
}

/** One changed resource, or part of one, that is not in the total. */
export interface Gap {
  address: string;
  action: Action;
  reason: string;
}

/** Everything left out of the total: whole resources and parts of estimated ones. */
export function gaps(estimate: PlanEstimate): Gap[] {
  return [
    ...estimate.notEstimated.map(({ address, action, reason }) => ({ address, action, reason })),
    ...estimate.resources.flatMap((r) =>
      r.partial.map((reason) => ({ address: r.address, action: r.action, reason })),
    ),
  ];
}

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => {
  const c = cents(n);
  return `${c > 0 ? "+" : c < 0 ? "-" : "±"}${money(c)}`;
};
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

interface Messages {
  headline: (delta: string) => string;
  verdict: (v: Verdict, delta: number, hasGaps: boolean) => string;
  gapWarning: (n: number) => string;
  summary: { monthly: string; before: string; after: string; expected: string };
  byResource: string;
  columns: [string, string, string, string, string];
  actions: Record<Action, string>;
  pricedUsage: string;
  gapTitle: (n: number) => string;
  gapColumns: [string, string, string];
  leftOutTitle: string;
  leftOutIntro: string;
  otherProviders: (n: number) => string;
  assumptionsIntro: string;
  assumptions: (ctx: RenderContext) => string[];
  howToDeclare: string;
  noChange: string;
}

const EN: Messages = {
  headline: (d) => `### 💰 Monthly cost change: **${d}** /mo`,
  verdict: (v, delta, hasGaps) => {
    const partly = hasGaps ? " for the estimated resources" : "";
    switch (v.kind) {
      case "exceeded":
        return delta > 0
          ? `> [!WARNING]\n> This is **${money(v.over)}/mo more** than the expected change (${signed(v.expected)}/mo)${partly}. Check that the increase is intended before merging.`
          : `> [!WARNING]\n> The cost goes down **${money(v.over)}/mo less** than expected (${signed(v.expected)}/mo)${partly}. Check the plan before merging.`;
      case "within":
        return hasGaps
          ? `> Within the expected change (${signed(v.expected)}/mo)${partly}. See below for what is not estimated.`
          : `> ✅ Within the expected change (${signed(v.expected)}/mo).`;
      case "undeclared":
        return "> [!IMPORTANT]\n> No expected change is declared for this PR. Is this increase what you expected?";
      case "no-increase":
        return hasGaps
          ? `> The estimated resources do not increase the monthly cost. See below for what is not estimated.`
          : "> ✅ This plan does not increase the monthly cost.";
    }
  },
  gapWarning: (n) =>
    `> [!CAUTION]\n> ${n} change${n === 1 ? " is" : "s are"} not included in this total. The real change can be larger.`,
  summary: { monthly: "Monthly", before: "Before", after: "After", expected: "Expected change" },
  byResource: "#### Changes by resource (largest increase first)",
  columns: ["Resource", "Action", "Before", "After", "Change"],
  actions: { create: "create", delete: "delete", update: "update", replace: "replace" },
  pricedUsage: "Priced usage",
  gapTitle: (n) => `#### ⚠️ Not estimated (${n})`,
  gapColumns: ["Resource", "Action", "What is missing"],
  leftOutTitle: "What the estimate leaves out",
  leftOutIntro: "Usage-based charges the plan cannot tell:",
  otherProviders: (n) =>
    `${n} changed resource${n === 1 ? "" : "s"} of non-AWS providers (such as random or null), not priced.`,
  assumptionsIntro: "Assumptions:",
  assumptions: (ctx) => [
    `Prices from the AWS Pricing Calculator API (rate type \`${ctx.rateType}\`), USD, before tax.`,
    `Region \`${ctx.region}\`. Running resources are priced for ${HOURS_PER_MONTH} hours a month; EC2 instances as Linux on-demand.`,
  ],
  howToDeclare:
    "To compare with what you expect, write `cost-expectation: +50` (USD per month) on its own line in the PR description.",
  noChange: "No resource in this plan changes the monthly cost.",
};

const JA: Messages = {
  headline: (d) => `### 💰 月額費用の変化: **${d}** /月`,
  verdict: (v, delta, hasGaps) => {
    const partly = hasGaps ? "（試算できたリソースについて）" : "";
    switch (v.kind) {
      case "exceeded":
        return delta > 0
          ? `> [!WARNING]\n> 想定した変化（${signed(v.expected)}/月）より **${money(v.over)}/月 多く** なります${partly}。マージの前に、この増加が意図したものかを確かめてください。`
          : `> [!WARNING]\n> 想定した変化（${signed(v.expected)}/月）ほど下がらず、**${money(v.over)}/月 少なく** しか下がりません${partly}。マージの前に plan を確かめてください。`;
      case "within":
        return hasGaps
          ? `> 想定した変化（${signed(v.expected)}/月）の範囲に収まっています${partly}。試算できなかったものは下にあります。`
          : `> ✅ 想定した変化（${signed(v.expected)}/月）の範囲に収まっています。`;
      case "undeclared":
        return "> [!IMPORTANT]\n> この PR には想定する費用の変化が書かれていません。この増加は想定どおりですか？";
      case "no-increase":
        return hasGaps
          ? "> 試算できたリソースでは月額費用は増えません。試算できなかったものは下にあります。"
          : "> ✅ この plan で月額費用は増えません。";
    }
  },
  gapWarning: (n) =>
    `> [!CAUTION]\n> ${n} 件の変更がこの合計に含まれていません。実際の変化はこれより大きくなることがあります。`,
  summary: { monthly: "月額", before: "変更前", after: "変更後", expected: "想定した変化" },
  byResource: "#### リソースごとの変化（増加の大きい順）",
  columns: ["リソース", "操作", "変更前", "変更後", "変化"],
  actions: { create: "作成", delete: "削除", update: "更新", replace: "置き換え" },
  pricedUsage: "試算した使用量",
  gapTitle: (n) => `#### ⚠️ 試算できなかったもの（${n} 件）`,
  gapColumns: ["リソース", "操作", "試算できなかったもの"],
  leftOutTitle: "試算に含まれないもの",
  leftOutIntro: "plan からは分からない、使用量で決まる料金:",
  otherProviders: (n) =>
    `AWS 以外のプロバイダー（random・null など）のリソース ${n} 件は試算していません。`,
  assumptionsIntro: "試算の前提:",
  assumptions: (ctx) => [
    `料金は AWS Pricing Calculator の API（料金の種類 \`${ctx.rateType}\`）による。米ドル・税抜き。`,
    `リージョンは \`${ctx.region}\`。稼働し続けるリソースは月 ${HOURS_PER_MONTH} 時間、EC2 インスタンスは Linux のオンデマンドとして試算。`,
  ],
  howToDeclare:
    "想定と比べるには、PR の説明に `cost-expectation: +50`（米ドル／月）を1行で書いてください。",
  noChange: "この plan に月額費用を変えるリソースはありません。",
};

export function marker(tag: string): string {
  return tag === "" ? "<!-- terraform-cost-comment -->" : `<!-- terraform-cost-comment:${tag} -->`;
}

/** Renders the PR comment. Unexpected increases and what is not estimated come first. */
export function renderComment(
  estimate: PlanEstimate,
  expected: number | undefined,
  ctx: RenderContext,
): string {
  const m = ctx.language === "ja" ? JA : EN;
  const verdict = judge(estimate.totalDelta, expected);
  const missing = gaps(estimate);
  const hasGaps = missing.length > 0;
  const out: string[] = [
    marker(ctx.tag),
    m.headline(signed(estimate.totalDelta)),
    "",
    m.verdict(verdict, cents(estimate.totalDelta), hasGaps),
  ];
  if (hasGaps) out.push("", m.gapWarning(missing.length));

  out.push(
    "",
    `| | ${m.summary.monthly} |`,
    "|---|---:|",
    `| ${m.summary.before} | ${money(estimate.totalBefore)} |`,
    `| ${m.summary.after} | ${money(estimate.totalAfter)} |`,
  );
  if (expected !== undefined) out.push(`| ${m.summary.expected} | ${signed(expected)} |`);

  if (estimate.resources.length > 0) {
    out.push(
      "",
      m.byResource,
      "",
      `| ${m.columns.join(" | ")} |`,
      "|---|---|---:|---:|---:|",
      ...estimate.resources.map(
        (r) =>
          `| \`${cell(r.address)}\` | ${m.actions[r.action]} | ${money(r.before)} | ${money(r.after)} | **${signed(r.delta)}** |`,
      ),
      "",
      `<details><summary>${m.pricedUsage}</summary>`,
      "",
      ...estimate.resources.flatMap((r) => [
        `- \`${cell(r.address)}\``,
        ...r.lines.map((l) => `  - ${cell(l.description)}: ${money(l.cost)}`),
      ]),
      "",
      "</details>",
    );
  } else if (!hasGaps) {
    out.push("", m.noChange);
  }

  if (hasGaps) {
    out.push(
      "",
      m.gapTitle(missing.length),
      "",
      `| ${m.gapColumns.join(" | ")} |`,
      "|---|---|---|",
      ...missing.map(
        (g) => `| \`${cell(g.address)}\` | ${m.actions[g.action]} | ${cell(g.reason)} |`,
      ),
    );
  }

  const leftOut = [...new Set(estimate.resources.flatMap((r) => r.excluded))];
  out.push("", `<details><summary>${m.leftOutTitle}</summary>`, "");
  if (leftOut.length > 0) out.push(m.leftOutIntro, "", ...leftOut.map((x) => `- ${x}`), "");
  if (estimate.otherProviderCount > 0) out.push(m.otherProviders(estimate.otherProviderCount), "");
  out.push(m.assumptionsIntro, "", ...m.assumptions(ctx).map((x) => `- ${x}`), "", "</details>");

  if (expected === undefined) out.push("", `<sub>${m.howToDeclare}</sub>`);
  return `${out.join("\n")}\n`;
}
