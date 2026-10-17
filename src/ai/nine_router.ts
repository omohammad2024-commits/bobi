/**
 * 9Router template.
 *
 * A 9Router deployment exposes a router endpoint whose exact wire format is
 * a deployment property, not a constant: it may speak the OpenAI chat
 * completions shape, or it may expose something else. Rather than guessing,
 * this template registers a provider whose adapter is chosen by what the
 * deployment actually answers:
 *
 *  - `openai_compatible` — the deployment answers the OpenAI chat-completions
 *    shape, which is the common case for a local router.
 *  - otherwise the owner selects the adapter that matches their endpoint.
 *
 * The template deliberately pre-fills NO base URL and NO model id: both come
 * from the owner's configuration. Nothing here contacts any address.
 */
import type { AdapterTemplate } from "./adapter";

export const NINE_ROUTER_TEMPLATE: AdapterTemplate = {
  type: "nine_router",
  label: "9Router",
  // Empty on purpose: a 9Router address is deployment-specific.
  suggestedBaseUrl: "",
  prefilled: false,
  capabilities: {
    notes: "آدرس، credential و شناسهٔ مدل توسط مدیر تعیین می‌شود",
  },
};
