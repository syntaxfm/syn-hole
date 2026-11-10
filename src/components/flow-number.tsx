import { lazy, Suspense, type ComponentProps, type HTMLAttributes } from "react";
import { ClientOnly } from "@tanstack/react-router";

// Cloudflare's `browser` export condition makes NumberFlow evaluate HTMLElement
// during SSR. ClientOnly must guard a LAZY import, not an eager module import.
const AnimatedNumber = lazy(() => import("@number-flow/react"));
export type FlowNumberProps = ComponentProps<typeof import("@number-flow/react").default>;

function NumberFallback(props: FlowNumberProps) {
  const {
    value, locales, format, prefix = "", suffix = "", style,
    ref: _ref, children: _children, animated: _animated, trend: _trend,
    respectMotionPreference: _motion, plugins: _plugins, digits: _digits,
    transformTiming: _transform, spinTiming: _spin, opacityTiming: _opacity,
    isolate: _isolate, willChange: _willChange,
    onAnimationsStart: _onStart, onAnimationsFinish: _onFinish,
    ...attributes
  } = props;
  // Modern Intl accepts numeric strings without losing decimal precision.
  // The assertion only bridges TypeScript's older Intl signature; no coercion.
  const text = `${prefix}${new Intl.NumberFormat(locales, format).format(value as number)}${suffix}`;
  return (
    <span
      role="img"
      aria-label={text}
      {...attributes as HTMLAttributes<HTMLSpanElement>}
      style={{ display: "inline-block", direction: "ltr", whiteSpace: "nowrap", lineHeight: 1, fontVariantNumeric: "tabular-nums", ...style }}
    >
      {text}
    </span>
  );
}

/** SSR and loading retain readable, formatted numbers; all props (including
 * the custom-element ref) reach the real NumberFlow once the browser loads it.
 */
export function FlowNumber(props: FlowNumberProps) {
  const fallback = <NumberFallback {...props} />;
  return (
    <ClientOnly fallback={fallback}>
      <Suspense fallback={fallback}>
        <AnimatedNumber {...props} />
      </Suspense>
    </ClientOnly>
  );
}
