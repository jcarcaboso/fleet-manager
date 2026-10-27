import { useFleet } from '@/context';
import type { GroupKey, SortKey } from './gallery';

/**
 * How the gallery is arranged. It belongs to the app context, so it outlives the page: coming back from a machine keeps the grouping,
 * the sort, whether the Retired section is open and the search text, as the old dashboard did (its `galleryReset` is the list of
 * moments that clear the search: signing out, creating a link, and removing or renaming a machine). Signing out clears the search
 * (see `createFleetContext`); the other prefs are only a layout and stay.
 */
export interface GalleryPrefs {
  groupBy: GroupKey;
  sort: SortKey;
  retiredOpen: boolean;
  search: string;
}

export const useGalleryPrefs = (): GalleryPrefs => useFleet().gallery;
