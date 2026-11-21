/** Languages the comment can be written in. */
export type Language = "en" | "ja";

/** A text shown in the comment, in every supported language. */
export type Msg = Readonly<Record<Language, string>>;

export const msg = (en: string, ja: string): Msg => ({ en, ja });

/** One line of usage to price with GetUsageLinesEstimatedCost. */
export interface UsageLine {
  serviceCode: string;
  usageType: string;
  operation: string;
  /** Monthly amount in the usage type's unit (hours, GB-Mo, IOPS-Mo ...). */
  amount: number;
  /** Human readable description of the line, e.g. "t3.micro (730 h)". */
  description: Msg;
}

/** Result of turning one resource's attributes into usage lines. */
export interface UsageResult {
  lines: UsageLine[];
  /**
   * Usage-based charges the plan cannot tell, e.g. "data processing (per GB)".
   * Same for every resource of the type, so they are shown once as a footnote.
   */
  excluded: Msg[];
  /**
   * Parts of this resource that would cost money but could not be priced, e.g. a root volume
   * whose size is known only after apply. Shown next to the resource as "not estimated".
   */
  partial: Msg[];
  /** Set when the resource could not be estimated at all. */
  unestimable?: Msg;
}

export type Attributes = Record<string, unknown>;
