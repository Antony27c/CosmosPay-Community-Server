import { mapWithConcurrency } from './map-with-concurrency';

describe('mapWithConcurrency', () => {
  it('caps in-flight work at N (20 items, cap 5)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    const results = await mapWithConcurrency(items, 5, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight -= 1;
      return item * 2;
    });

    expect(results).toEqual(items.map((i) => i * 2));
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBe(5);
  });

  it('returns [] for an empty input', async () => {
    const fn = jest.fn();
    await expect(mapWithConcurrency([], 5, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
