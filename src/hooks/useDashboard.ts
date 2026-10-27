/**
 * useDashboard.ts — reactive binding between the Dexie event log and React.
 *
 * Re-queries the aggregation whenever the range tab changes or new rolls
 * land in IndexedDB (Dexie `changes` event), so the dashboard stays live
 * without any polling.
 */
import { useEffect, useState } from 'react';
import {
  emptyDashboard,
  getDashboardData,
  onRollsChanged,
  type DashboardData,
  type RangeKey,
} from '../services/eventLog';

/**
 * Dashboard snapshot for one time range.
 * Resolves to `emptyDashboard()` until the first query finishes.
 */
export function useDashboard(range: RangeKey): DashboardData {
  const [data, setData] = useState<DashboardData>(() => emptyDashboard());

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void getDashboardData(range)
        .then((d) => { if (alive) setData(d); })
        .catch(() => { /* DB read failed: keep last known snapshot */ });
    };
    refresh();
    const off = onRollsChanged(refresh);
    return () => {
      alive = false;
      off();
    };
  }, [range]);

  return data;
}