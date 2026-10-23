// SPDX-License-Identifier: BUSL-1.1
import { onBeforeUnmount, ref, watchEffect } from 'vue';

// The name of the object a detail page is showing, for the breadcrumb.
// Keyed by the object's id so the topbar never pairs one record's name with
// another record's route while pages swap.
const current = ref<{ id: string; name: string } | null>(null);

// Called by a detail page with its id and the loaded record's name (null
// while loading).
export function useRecordCrumb(id: () => string, name: () => string | null | undefined): void {
  watchEffect(() => {
    const n = name();
    if (n) current.value = { id: id(), name: n };
    else if (current.value?.id === id()) current.value = null;
  });
  onBeforeUnmount(() => {
    if (current.value?.id === id()) current.value = null;
  });
}

// The breadcrumb label for the record at `id`, or `placeholder` until its
// page has loaded it.
export function recordCrumbLabel(id: unknown, placeholder: string): string {
  return typeof id === 'string' && current.value?.id === id ? current.value.name : placeholder;
}
