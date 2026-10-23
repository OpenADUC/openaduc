// SPDX-License-Identifier: BUSL-1.1
import { computed, watch, type WritableComputedRef } from 'vue';
import { useRoute, useRouter } from 'vue-router';

export interface RouteTab<T extends string> {
  id: T;
  visible: boolean;
}

// The active tab, kept in the `tab` query parameter (see README). A known
// but hidden tab isn't judged until `ready`: some tabs only appear once the
// record has loaded.
export function useRouteTab<T extends string>(opts: {
  tabs: () => readonly RouteTab<T>[];
  fallback: T;
  ready: () => boolean;
}): WritableComputedRef<T> {
  const route = useRoute();
  const router = useRouter();
  // The route is global: while leaving, it moves on before this page
  // unmounts. Only read or write the query of this page's own route.
  const ownRoute = route.name;
  const isOwnRoute = () => route.name === ownRoute;

  const requested = computed(() => {
    const q = route.query.tab;
    return isOwnRoute() && typeof q === 'string' ? q : null;
  });

  const verdict = computed<'valid' | 'invalid' | 'pending'>(() => {
    const id = requested.value;
    if (id === null) return 'valid';
    const tab = opts.tabs().find((t) => t.id === id);
    if (!tab) return 'invalid';
    if (tab.visible) return 'valid';
    return opts.ready() ? 'invalid' : 'pending';
  });

  function setQueryTab(id: T | null): void {
    if (!isOwnRoute()) return;
    const query = { ...route.query };
    if (id === null || id === opts.fallback) delete query.tab;
    else query.tab = id;
    void router.replace({ query, hash: route.hash });
  }

  watch(
    verdict,
    (v) => {
      if (v === 'invalid') setQueryTab(null);
    },
    { immediate: true },
  );

  return computed<T>({
    get: () =>
      requested.value !== null && verdict.value !== 'invalid'
        ? (requested.value as T)
        : opts.fallback,
    set: (id) => setQueryTab(id),
  });
}
