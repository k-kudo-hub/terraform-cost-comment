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

/**
 * Compares the estimated change with what the PR author expected. A PR author usually expects
 * some increase; what costs money is an increase nobody expected.
 */
export function judge(delta: number, expected: number | undefined): Verdict {
  if (expected === undefined) return delta > 0 ? { kind: "undeclared" } : { kind: "no-increase" };
  if (delta > expected) {
    return { kind: "exceeded", expected, over: Math.round((delta - expected) * 100) / 100 };
  }
  return { kind: "within", expected };
}

/** Whether the change is one nobody declared they expected. */
export function isUnexpected(verdict: Verdict): boolean {
  return verdict.kind === "exceeded" || verdict.kind === "undeclared";
}

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "-" : "±"}${money(n)}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

interface Messages {
  headline: (delta: string) => string;
  verdict: (v: Verdict) => string;
  notEstimatedWarning: (n: number) => string;
  summary: { monthly: string; before: string; after: string; expected: string };
  byResource: string;
  columns: [string, string, string, string, string];
  actions: Record<Action, string>;
  pricedUsage: string;
  notEstimatedTitle: (n: number) => string;
  notEstimatedColumns: [string, string, string];
  leftOutTitle: string;
  leftOutIntro: string;
  assumptionsIntro: string;
  assumptions: (ctx: RenderContext) => string[];
  howToDeclare: string;
  noChange: string;
}

const EN: Messages = {
  headline: (d) => `### 💰 Monthly cost change: **${d}** /mo`,
  verdict: (v) => {
    switch (v.kind) {
      case "exceeded":
        return `> [!WARNING]\n> This is **${money(v.over)}/mo more** than the expected change (${signed(v.expected)}/mo). Check that the increase is intended before merging.`;
      case "within":
        return `> ✅ Within the expected change (${signed(v.expected)}/mo).`;
      case "undeclared":
        return "> [!IMPORTANT]\n> No expected change is declared for this PR. Is this increase what you expected?";
      case "no-increase":
        return "> ✅ This plan does not increase the monthly cost.";
    }
  },
  notEstimatedWarning: (n) =>
    `> ⚠️ ${n} changed resource${n === 1 ? " is" : "s are"} not included in this total. The real change can be larger.`,
  summary: { monthly: "Monthly", before: "Before", after: "After", expected: "Expected change" },
  byResource: "#### Changes by resource (largest increase first)",
  columns: ["Resource", "Action", "Before", "After", "Change"],
  actions: { create: "create", delete: "delete", update: "update", replace: "replace" },
  pricedUsage: "Priced usage",
  notEstimatedTitle: (n) => `#### ⚠️ Not estimated (${n})`,
  notEstimatedColumns: ["Resource", "Action", "Why"],
  leftOutTitle: "What the estimate leaves out",
  leftOutIntro: "Not included in the estimate:",
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
  verdict: (v) => {
    switch (v.kind) {
      case "exceeded":
        return `> [!WARNING]\n> 想定した変化（${signed(v.expected)}/月）より **${money(v.over)}/月 多く** なります。マージの前に、この増加が意図したものかを確かめてください。`;
      case "within":
        return `> ✅ 想定した変化（${signed(v.expected)}/月）の範囲に収まっています。`;
      case "undeclared":
        return "> [!IMPORTANT]\n> この PR には想定する費用の変化が書かれていません。この増加は想定どおりですか？";
      case "no-increase":
        return "> ✅ この plan で月額費用は増えません。";
    }
  },
  notEstimatedWarning: (n) =>
    `> ⚠️ 変更されるリソースのうち ${n} 件は、この合計に含まれていません。実際の変化はこれより大きくなることがあります。`,
  summary: { monthly: "月額", before: "変更前", after: "変更後", expected: "想定した変化" },
  byResource: "#### リソースごとの変化（増加の大きい順）",
  columns: ["リソース", "操作", "変更前", "変更後", "変化"],
  actions: { create: "作成", delete: "削除", update: "更新", replace: "置き換え" },
  pricedUsage: "試算した使用量",
  notEstimatedTitle: (n) => `#### ⚠️ 試算できなかったリソース（${n} 件）`,
  notEstimatedColumns: ["リソース", "操作", "理由"],
  leftOutTitle: "試算に含まれないもの",
  leftOutIntro: "試算に含めていないもの:",
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

/** Renders the PR comment. Unexpected increases and unestimated resources come first. */
export function renderComment(
  estimate: PlanEstimate,
  expected: number | undefined,
  ctx: RenderContext,
): string {
  const m = ctx.language === "ja" ? JA : EN;
  const verdict = judge(estimate.totalDelta, expected);
  const out: string[] = [
    marker(ctx.tag),
    m.headline(signed(estimate.totalDelta)),
    "",
    m.verdict(verdict),
  ];
  if (estimate.notEstimated.length > 0) {
    out.push("", m.notEstimatedWarning(estimate.notEstimated.length));
  }

  out.push(
    "",
    `| | ${m.summary.monthly} |`,
    "|---|---:|",
    `| ${m.summary.before} | ${money(estimate.totalBefore)} |`,
    `| ${m.summary.after} | ${money(estimate.totalAfter)} |`,
  );
  if (expected !== undefined) out.push(`| ${m.summary.expected} | ${signed(expected)} |`);

  if (estimate.resources.length === 0) {
    out.push("", m.noChange);
  } else {
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
  }

  if (estimate.notEstimated.length > 0) {
    out.push(
      "",
      m.notEstimatedTitle(estimate.notEstimated.length),
      "",
      `| ${m.notEstimatedColumns.join(" | ")} |`,
      "|---|---|---|",
      ...estimate.notEstimated.map(
        (n) => `| \`${cell(n.address)}\` | ${m.actions[n.action]} | ${cell(n.reason)} |`,
      ),
    );
  }

  const leftOut = [...new Set(estimate.resources.flatMap((r) => r.excluded))];
  out.push("", `<details><summary>${m.leftOutTitle}</summary>`, "");
  if (leftOut.length > 0) out.push(m.leftOutIntro, "", ...leftOut.map((x) => `- ${x}`), "");
  out.push(m.assumptionsIntro, "", ...m.assumptions(ctx).map((x) => `- ${x}`), "", "</details>");

  if (expected === undefined) out.push("", `<sub>${m.howToDeclare}</sub>`);
  return `${out.join("\n")}\n`;
}
