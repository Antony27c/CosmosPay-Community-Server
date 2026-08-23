import { validate } from 'class-validator';
import { IsRedirectUrl } from './is-redirect-url.validator';

class SampleDto {
  @IsRedirectUrl()
  redirect_url!: string;
}

async function errorsFor(url: unknown): Promise<string[]> {
  const dto = new SampleDto();
  (dto as { redirect_url: unknown }).redirect_url = url;
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('IsRedirectUrl', () => {
  it('allows an absolute https URL without credentials', async () => {
    await expect(
      errorsFor('https://app.acme.com/kyc/return'),
    ).resolves.toEqual([]);
  });

  it('rejects a non-https scheme', async () => {
    const messages = await errorsFor('http://app.acme.com/kyc/return');
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/https URL without embedded credentials/i),
      ]),
    );
  });

  it('rejects embedded credentials', async () => {
    const messages = await errorsFor(
      'https://user:pass@app.acme.com/kyc/return',
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it('rejects a non-absolute / invalid URL', async () => {
    const messages = await errorsFor('/relative/path');
    expect(messages.length).toBeGreaterThan(0);
  });
});
