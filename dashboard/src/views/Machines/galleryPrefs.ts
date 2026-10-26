import { reactive } from 'vue';
import { useFleet, type FleetContext } from '@/context';
import type { GroupKey, SortKey } from './gallery';

/**
 * How the gallery is arranged. It outlives the page: coming back from a machine keeps the grouping, the sort and whether the
 * Retired section is open, as the old dashboard did. The search text does not (a new visit starts with an empty search).
 */
export interface GalleryPrefs {
  groupBy: GroupKey;
  sort: SortKey;
  retiredOpen: boolean;
}

const store = new WeakMap<object, GalleryPrefs>();

export function galleryPrefs(ctx: FleetContext): GalleryPrefs {
  let prefs = store.get(ctx.openState);
  if (!prefs) {
    prefs = reactive<GalleryPrefs>({ groupBy: 'status', sort: 'attention', retiredOpen: false });
    store.set(ctx.openState, prefs);
  }
  return prefs;
}
export const useGalleryPrefs = (): GalleryPrefs => galleryPrefs(useFleet());
