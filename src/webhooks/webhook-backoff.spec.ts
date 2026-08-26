import { computeWebhookBackoffMs } from './webhook-backoff';

describe('computeWebhookBackoffMs', () => {
  it('es exponencial, respeta maxBackoffMs como techo y dos llamadas seguidas con el mismo attempts dan valores distintos (jitter)', () => {
    const baseMs = 1000;
    const maxBackoffMs = 8000;
    const noJitter = () => 1; // factor = 1.0

    expect(computeWebhookBackoffMs(1, baseMs, maxBackoffMs, noJitter)).toBe(
      2000,
    );
    expect(computeWebhookBackoffMs(2, baseMs, maxBackoffMs, noJitter)).toBe(
      4000,
    );
    expect(computeWebhookBackoffMs(3, baseMs, maxBackoffMs, noJitter)).toBe(
      8000,
    );
    expect(computeWebhookBackoffMs(4, baseMs, maxBackoffMs, noJitter)).toBe(
      8000,
    );

    const a = computeWebhookBackoffMs(3, baseMs, maxBackoffMs, () => 0);
    const b = computeWebhookBackoffMs(3, baseMs, maxBackoffMs, () => 1);
    expect(a).toBe(4000); // 8000 * 0.5
    expect(b).toBe(8000); // 8000 * 1.0
    expect(a).not.toBe(b);

    const random = jest.spyOn(Math, 'random');
    random.mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);
    const first = computeWebhookBackoffMs(5, baseMs, maxBackoffMs);
    const second = computeWebhookBackoffMs(5, baseMs, maxBackoffMs);
    expect(first).not.toBe(second);
    random.mockRestore();
  });
});
