import {
  buildSignatureHeader,
  signPayload,
  signingSecretsFor,
} from './webhook-signature';

describe('webhook-signature', () => {
  const body = '{"id":"evt_1"}';
  const ts = 1_700_000_000;
  const current = 'whsec_new';
  const previous = 'whsec_old';

  it('emits a single v1 token when given one secret (never-rotated shape)', () => {
    const header = buildSignatureHeader([current], body, ts);
    expect(header).toBe(`t=${ts},v1=${signPayload(current, body, ts)}`);
  });

  it('emits t= then one v1= per secret, current first', () => {
    const header = buildSignatureHeader([current, previous], body, ts);
    expect(header).toBe(
      `t=${ts},v1=${signPayload(current, body, ts)},v1=${signPayload(previous, body, ts)}`,
    );
  });

  it('signingSecretsFor includes previousSecret only while grace is open', () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);

    expect(
      signingSecretsFor({
        secret: current,
        previousSecret: previous,
        previousSecretExpiresAt: future,
      }),
    ).toEqual([current, previous]);

    expect(
      signingSecretsFor({
        secret: current,
        previousSecret: previous,
        previousSecretExpiresAt: past,
      }),
    ).toEqual([current]);

    expect(
      signingSecretsFor({
        secret: current,
        previousSecret: null,
        previousSecretExpiresAt: null,
      }),
    ).toEqual([current]);
  });
});
