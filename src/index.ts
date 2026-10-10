export type { CounterField, CounterObservation, CounterObservations, CounterState } from "./domain/counters.js"
export { COUNTER_FIELDS, counterValue, observedCounters } from "./domain/counters.js"
export {
  type FormattedText,
  type HtmlFormatting,
  type MarkdownFormatting,
  type TextSpan,
  validateFormattedText,
} from "./domain/formatting.js"
export { formatLocator, isLocator, type MessageLocator, parseLocator } from "./domain/locator.js"
export { type Markup, parseMarkdown } from "./domain/markdown.js"
export {
  canonicalMeetingReference,
  formatMeetingReference,
  type MeetingReference,
  parseMeetingReference,
} from "./domain/meeting-reference.js"
export type { MessageLink, MessagePermalink } from "./domain/message-link.js"
export type * from "./domain/models.js"
export type { RankingGraphEvidence, RankingGraphLink } from "./domain/rankings-graph.js"
export type {
  RankingComponent,
  RankingInput,
  RankingMeasure,
  RankingOptions,
  RankingTarget,
  RankingWeights,
  ScorePreset,
} from "./domain/rankings-options.js"
export { rankingOptions } from "./domain/rankings-options.js"
export { canonicalReference, formatReference, parseReference, type Reference } from "./domain/references.js"
export { normalizeTag, TAG_TYPES, type TagType } from "./domain/tags.js"
export type { CheckRow, Finding, Moderator } from "./moderation/check.js"
export { act, judge } from "./moderation/check.js"
export type { GroupRules } from "./moderation/rules.js"
export { defaultRules, ModerationRules, moderationPathFor } from "./moderation/rules.js"
export { type OutputOptions, resolveOutput } from "./output.js"
export { type RenderOptions, renderMessage, renderMessages } from "./render/messages.js"
export { isId, type PeopleLookup, pickChat, pickPerson } from "./resolve.js"
export { readSecret, type SecretInput } from "./terminal/prompt.js"
export { qrPng, terminalQr } from "./terminal/qr.js"
