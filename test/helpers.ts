import type { Msg } from "../src/types.js";

/** English texts of messages, for assertions. */
export const en = (items: readonly Msg[] | undefined): string[] => (items ?? []).map((m) => m.en);

/** A message with the same text in every language, for building test data. */
export const same = (text: string): Msg => ({ en: text, ja: text });
