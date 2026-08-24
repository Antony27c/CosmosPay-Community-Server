import { Logger } from '@nestjs/common';
import type { ObserverName, StellarService } from '../stellar/stellar.service';

/**
 * How many observer intervals a single cycle may occupy before the lock is
 * force-released. Combined with StellarService.call() timeouts this turns a
 * hung tick into noisy retries instead of a silent freeze.
 */
export const OBSERVER_WATCHDOG_MULTIPLIER = 2;

/**
 * Arms a timer that logs and releases `running` if a cycle overruns. Returns
 * a cancel function for the happy path. Uses a generation counter so a late
 * `finally` from the hung cycle cannot clear a newer cycle's lock.
 */
export function armObserverWatchdog(opts: {
  logger: Logger;
  name: string;
  observer: ObserverName;
  stellar: StellarService;
  intervalMs: number;
  generation: number;
  currentGeneration: () => number;
  setRunning: (value: boolean) => void;
}): () => void {
  const limitMs = opts.intervalMs * OBSERVER_WATCHDOG_MULTIPLIER;
  const timer = setTimeout(() => {
    if (opts.currentGeneration() !== opts.generation) {
      return;
    }
    opts.logger.error(
      `${opts.name} cycle exceeded ${limitMs}ms (` +
        `${OBSERVER_WATCHDOG_MULTIPLIER}× interval); releasing lock`,
    );
    opts.stellar.recordWatchdogTrip(opts.observer);
    opts.setRunning(false);
  }, limitMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
