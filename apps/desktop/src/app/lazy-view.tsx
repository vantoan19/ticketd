import {
  Component,
  lazy,
  Suspense,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { FailureState } from "@/components/ui/failure-alert";
import { describeFailure } from "@/lib/api/describe-failure";

/**
 * A view whose module loads when it first renders, or earlier through
 * `preload`. A loaded view renders at once, without suspending; until then
 * `Fallback` (or nothing) stands in its place with the same props.
 */
export function lazyView<P extends object>(
  load: () => Promise<ComponentType<P>>,
  Fallback?: ComponentType<P>,
) {
  let loaded: ComponentType<P> | undefined;
  const preload = () =>
    load().then((view) => {
      loaded = view;
    });
  const Pending = lazy(async () => {
    await preload();
    return { default: loaded as ComponentType<P> };
  });
  function LazyView(props: P) {
    // Chosen once: changing the component type later would reset the view.
    const [View] = useState<ComponentType<P>>(() => loaded ?? Pending);
    return (
      <LoadFailure>
        <Suspense fallback={Fallback ? <Fallback {...props} /> : null}>
          <View {...props} />
        </Suspense>
      </LoadFailure>
    );
  }
  return Object.assign(LazyView, { preload });
}

/** A view whose module could not load says so in its place. */
class LoadFailure extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  override state = { error: undefined as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <FailureState
        failure={{
          ...describeFailure(this.state.error, "load this view"),
          sentence: "Quit and reopen ticketd to try again.",
        }}
      />
    );
  }
}
