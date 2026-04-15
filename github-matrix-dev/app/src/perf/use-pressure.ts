/**
 * React hook for subscribing to the PressureMonitor.
 *
 * Returns the latest sample (or null until the first sample lands).
 */

import { useEffect, useState } from 'react';
import { pressureMonitor, type PressureSample } from './pressure-monitor';

export function usePressure(): PressureSample | null {
  const [sample, setSample] = useState<PressureSample | null>(() => pressureMonitor.getLastSample());
  useEffect(() => {
    return pressureMonitor.subscribe(setSample);
  }, []);
  return sample;
}
