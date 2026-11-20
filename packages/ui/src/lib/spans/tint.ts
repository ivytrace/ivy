import type { ScopeTint } from "./services";

/** Icon background (behind the white `custom` glyph) and waterfall bar per scope tint. */
export const TINT_CLASSES: Record<ScopeTint, { icon: string; bar: string }> = {
  teal: { icon: "bg-teal-600", bar: "bg-teal-400" },
  blue: { icon: "bg-blue-600", bar: "bg-blue-400" },
  indigo: { icon: "bg-indigo-500", bar: "bg-indigo-400" },
  lime: { icon: "bg-lime-600", bar: "bg-lime-400" },
};
