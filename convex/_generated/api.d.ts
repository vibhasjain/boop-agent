/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as automations from "../automations.js";
import type * as consolidation from "../consolidation.js";
import type * as conversations from "../conversations.js";
import type * as dashboard from "../dashboard.js";
import type * as drafts from "../drafts.js";
import type * as memoryEvents from "../memoryEvents.js";
import type * as memoryRecords from "../memoryRecords.js";
import type * as messages from "../messages.js";
import type * as sendblueDedup from "../sendblueDedup.js";
import type * as usageRecords from "../usageRecords.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  automations: typeof automations;
  consolidation: typeof consolidation;
  conversations: typeof conversations;
  dashboard: typeof dashboard;
  drafts: typeof drafts;
  memoryEvents: typeof memoryEvents;
  memoryRecords: typeof memoryRecords;
  messages: typeof messages;
  sendblueDedup: typeof sendblueDedup;
  usageRecords: typeof usageRecords;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
