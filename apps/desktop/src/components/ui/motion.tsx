import {
  useEffect,
  type ComponentProps,
  type ComponentType,
  type ElementType,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  domMax,
  LazyMotion,
  m,
  MotionConfig,
} from "motion/react";
import { cn } from "cn";
import { installMotionGuard } from "@/lib/motion-guard";
import {
  blur,
  enterTransition,
  exitTransition,
  rise,
  spring,
  staggerDelay,
} from "@/lib/motion-tokens";
import "./motion.css";

/**
 * The Refined motion language (DESIGN.md section 12) as small pieces. Timing,
 * distances and blur come from the tokens in styles.css, so reduced motion and
 * the input guard reach every piece the same way; none of them takes a duration.
 * CSS does fades, expand, sheen and shimmer; the `motion` library does what
 * needs springs and measured layout: Appear's rise and Glide.
 */

/**
 * Mount once at the app root. Loads the motion library, follows the system's
 * reduced-motion setting, and guards input: a held key or rapid clicks make
 * motion instant (lib/motion-guard). Components use `m`, never `motion`.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  useEffect(() => installMotionGuard(), []);
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/**
 * Keeps children that leave in place until their exit finishes. Put it around
 * a conditional `<Appear key=…>` (or any `m` element with an `exit`).
 */
export { AnimatePresence as Presence };

type AppearProps = Omit<
  ComponentProps<typeof m.div>,
  "initial" | "animate" | "exit" | "transition"
> & {
  /** `row` rises 6px; `overlay` (messages, menus, dialogs) rises 8px. */
  rise?: "row" | "overlay";
  /** Place in a cascade: later items start a stagger step after earlier ones. */
  index?: number;
};

/**
 * Fades up from a soft blur and settles into place, then leaves faster, fading
 * to a slight blur. Render it inside `Presence` to animate the leaving.
 */
export function Appear({
  rise: kind = "row",
  index = 0,
  ...props
}: AppearProps) {
  const delay = staggerDelay(index);
  return (
    <m.div
      data-slot="appear"
      initial={{
        opacity: 0,
        y: rise(kind),
        filter: `blur(${blur("in")}px)`,
      }}
      animate={{
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        // Once settled, drop the filter itself: a resting blur(0px) still keeps
        // a compositing layer on every row of a long list.
        transitionEnd: { filter: "none" },
        // The stagger waits inside each property's own transition: Motion reads
        // a sibling `delay` for none of them once `default` is present.
        transition: {
          default: { ...enterTransition(), delay },
          y: { ...spring("smooth"), delay },
        },
      }}
      exit={{
        opacity: 0,
        filter: `blur(${blur("out")}px)`,
        transition: exitTransition(),
      }}
      {...props}
    />
  );
}

/**
 * The highlight that travels between items (sidebar, tabs, menus, palette).
 * Render it inside whichever item is active, with one `id` per group; it glides
 * from the previous item. The item needs `position: relative`; give the
 * highlight its fill with `className`.
 */
export function Glide({ id, className }: { id: string; className?: string }) {
  return (
    <m.span
      data-slot="glide"
      aria-hidden="true"
      layoutId={id}
      transition={spring("glide")}
      className={cn("ui-glide", className)}
    />
  );
}

/**
 * A scrolling list's component, made a `layoutScroll` host: pass `layoutScroll`
 * to the result. A Glide measures its old row against any scrolled ancestor
 * marked this way; without it the highlight starts off its old row once the
 * list has scrolled. Use it on every element that scrolls rows with a Glide.
 */
export function scrollHost<C extends ElementType>(Component: C) {
  // `m.create` types `style` as MotionStyle, which `exactOptionalPropertyTypes`
  // refuses for a component whose props say `CSSProperties | undefined`. The
  // props reach the component unchanged, so its own props type stands.
  return m.create(Component) as unknown as ComponentType<
    ComponentProps<C> & { layoutScroll: true }
  >;
}

/**
 * Text that changes in place: the old words fade out while the new fade in.
 * Put it inside `MotionProvider`.
 */
export function CrossfadeText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span data-slot="crossfade" className={cn("ui-crossfade", className)}>
      <AnimatePresence initial={false}>
        <m.span
          key={children}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: enterTransition() }}
          exit={{ opacity: 0, transition: exitTransition() }}
        >
          {children}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

/**
 * Height that opens and closes on the smooth spring (rows 0fr to 1fr). Closed
 * content stays mounted but inert, out of reach and out of the accessibility
 * tree.
 */
export function Expand({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="expand"
      data-open={open}
      inert={!open}
      className={cn("ui-expand", className)}
    >
      <div className="ui-expand-body">{children}</div>
    </div>
  );
}

/**
 * The `--hover` fill that fades out behind what just arrived: a moved row, a
 * followed link. Renders nothing until `at` is set and plays again whenever
 * `at` changes (pass a counter or a timestamp). Place it in an element with
 * `position: relative; isolation: isolate`.
 */
export function Arrival({ at }: { at?: string | number }) {
  if (at === undefined) return null;
  return (
    <span
      key={at}
      data-slot="arrival"
      aria-hidden="true"
      className="ui-arrival"
    />
  );
}

/**
 * An SVG path drawn along its length when it mounts: a check, a connector.
 * Remount it (`key`) to draw again. Set `stroke` and `fill="none"` as usual.
 */
export function DrawnPath({ className, ...props }: ComponentProps<"path">) {
  return (
    <path
      data-slot="drawn-path"
      pathLength={1}
      className={cn("ui-drawn", className)}
      {...props}
    />
  );
}

/** A soft light passing over words, for the step that is live: "Working". */
export function Shimmer({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      data-slot="shimmer"
      className={cn("ui-shimmer", className)}
      {...props}
    />
  );
}
