import type { Ticket } from "@/lib/api/client";

/** Pass instead of arguments to say "not yet": the read stays idle and makes no call. */
export const skip = Symbol("skip");
export type Skip = typeof skip;

/**
 * A value for one cache entry, built from a declared read (`fillRead`,
 * `updateRead`, `updatePagedRead`). Parts of a page export builders for the
 * writes of their section, so a view never names a read.
 */
export type Fill = {
  readonly key: readonly unknown[];
  /**
   * The entry's new value from its cached one (undefined when nothing is
   * cached); undefined leaves the entry as it is.
   */
  readonly apply: (cached: unknown) => unknown;
};

/**
 * What a write returned or set, so reads can show it before the next read
 * finishes: returned Tickets fill the reads that declare `seededBy.ticket`, and
 * `fills` fill any other declared read.
 */
export type Returned = {
  ticket?: Ticket | readonly Ticket[] | null;
  fills?: readonly Fill[];
};

type Seeding<A, V> = {
  /** How a returned Ticket fills this read; null when it does not concern it. */
  ticket?: (ticket: Ticket) => { args: A; value: V } | null;
};

/**
 * A read declared once: its identity, its client call and its failure words.
 * Arguments are JSON-like values; identity is `key` plus the arguments compared
 * structurally. A call must resolve to a value other than `undefined`.
 */
export type ReadSpec<A, V> = {
  readonly kind: "read";
  readonly key: string;
  readonly call: (args: A) => Promise<V>;
  readonly failure: string | ((args: A) => string);
};

/** A read in pages: "Show more" reads one more, a change re-reads all loaded ones. */
export type PagedReadSpec<A, V, P = unknown> = {
  readonly kind: "paged";
  readonly key: string;
  readonly call: (args: A, offset: number) => Promise<P>;
  /** The next offset, or null when there are no more pages. */
  readonly next: (page: P, pages: readonly P[]) => number | null;
  readonly join: (pages: readonly P[]) => V;
  readonly failure: string | ((args: A) => string);
  readonly more: string | ((args: A) => string);
};

// How each read that declares `seededBy.ticket` is filled from a returned Ticket.
const seeders: ((ticket: Ticket) => Fill | null)[] = [];

export function read<A, V>(spec: {
  key: string;
  call: (args: A) => Promise<V>;
  failure: string | ((args: A) => string);
  seededBy?: Seeding<A, V>;
}): ReadSpec<A, V> {
  const declared: ReadSpec<A, V> = {
    kind: "read",
    key: spec.key,
    call: spec.call,
    failure: spec.failure,
  };
  const fill = spec.seededBy?.ticket;
  if (fill) {
    seeders.push((ticket) => {
      const seed = fill(ticket);
      return seed
        ? { key: readKey(declared, seed.args), apply: () => seed.value }
        : null;
    });
  }
  return declared;
}

export function pagedRead<A, P, V>(spec: {
  key: string;
  call: (args: A, offset: number) => Promise<P>;
  next: (page: P, pages: readonly P[]) => number | null;
  join: (pages: readonly P[]) => V;
  failure: string | ((args: A) => string);
  more: string | ((args: A) => string);
}): PagedReadSpec<A, V, P> {
  return { kind: "paged", ...spec };
}

/**
 * `next` for a core that answers `pageSize` items at a time, from an offset: a
 * full page means there may be another, a shorter one is the last.
 */
export function byOffset<T>(
  pageSize: number,
): (page: readonly T[], pages: readonly (readonly T[])[]) => number | null {
  return (page, pages) =>
    page.length === pageSize
      ? pages.reduce((count, loaded) => count + loaded.length, 0)
      : null;
}

/** The cache identity of a read with these arguments. */
export function readKey(
  spec: { kind: string; key: string },
  args: unknown,
): readonly unknown[] {
  return [spec.kind, spec.key, args === skip ? null : (args ?? null)];
}

export function words<A>(
  text: string | ((args: A) => string),
  args: A,
): string {
  return typeof text === "function" ? text(args) : text;
}

/**
 * Fills `spec`'s entry for `args` with `value`, creating it when nothing is
 * cached. A re-read that fails afterwards keeps it; the next one replaces it.
 */
export function fillRead<A, V>(spec: ReadSpec<A, V>, args: A, value: V): Fill {
  return { key: readKey(spec, args), apply: () => value };
}

/**
 * Changes what is cached for `spec` and `args`, if anything is: an entry that
 * does not exist is not created. `update` returns the new value (the same one
 * when nothing changes).
 */
export function updateRead<A, V>(
  spec: ReadSpec<A, V>,
  args: A,
  update: (cached: V) => V,
): Fill {
  return {
    key: readKey(spec, args),
    apply: (cached) => {
      if (cached === undefined) return undefined;
      const next = update(cached as V);
      return Object.is(next, cached) ? undefined : next;
    },
  };
}

/**
 * Changes the pages of a paged read that are loaded, one page at a time and
 * only if some change: `update` returns the same page when it holds nothing to
 * change. An entry that does not exist is not created.
 */
export function updatePagedRead<A, V, P>(
  spec: PagedReadSpec<A, V, P>,
  args: A,
  update: (page: P) => P,
): Fill {
  return {
    key: readKey(spec, args),
    apply: (cached) => {
      if (cached === undefined) return undefined;
      const data = cached as { pages: P[]; pageParams: unknown[] };
      const pages = data.pages.map((page) => update(page));
      return pages.every((page, index) => page === data.pages[index])
        ? undefined
        : { ...data, pages };
    },
  };
}

/** Every cache entry that the returned Tickets and fills fill. */
export function fillsFor(returned: Returned | undefined): Fill[] {
  const fills: Fill[] = [];
  for (const ticket of [returned?.ticket ?? []].flat()) {
    for (const seeder of seeders) {
      const seed = seeder(ticket);
      if (seed) fills.push(seed);
    }
  }
  fills.push(...(returned?.fills ?? []));
  return fills;
}
