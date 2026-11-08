export type Intent = "cancel" | "undo" | "status" | "help" | "yes" | "no" | "ship" | "text";

const PATTERNS: [Intent, RegExp][] = [
  ["cancel", /^(cancel|stop|never ?mind|nvm|abort)$/],
  ["undo", /^(undo|roll ?back|revert)( (it|that|last|the last change))?$/],
  ["status", /^(status|what'?s happening|where are we)$/],
  ["help", /^(help|\?|commands)$/],
  ["ship", /^(ship( it)?|deploy( it)?|send it|merge( it)?)$/],
  ["yes", /^(y|yes|yep|yup|yeah|ya|ok|okay|k|sure|do it|go|go ahead|sounds good|looks good|lgtm|correct|confirm|👍)$/],
  ["no", /^(n|no|nope|nah|wrong|not quite)$/],
];

export function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!,]+$/g, "")
    .replace(/\s+/g, " ");
}

export function detectIntent(text: string): Intent {
  const t = normalize(text);
  for (const [intent, re] of PATTERNS) if (re.test(t)) return intent;
  return "text";
}
