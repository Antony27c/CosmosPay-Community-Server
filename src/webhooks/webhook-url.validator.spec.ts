import {
  assertPublicWebhookUrl,
  WebhookUrlValidationError,
} from './webhook-url.validator';

describe('assertPublicWebhookUrl', () => {
  const publicLookup = jest.fn(async () => ['93.184.216.34']); // example.com

  beforeEach(() => {
    publicLookup.mockReset();
    publicLookup.mockResolvedValue(['93.184.216.34']);
  });

  it('allows https URLs that resolve to a public address', async () => {
    await expect(
      assertPublicWebhookUrl('https://integrator.example.com/hooks', publicLookup),
    ).resolves.toBeUndefined();
    expect(publicLookup).toHaveBeenCalledWith('integrator.example.com');
  });

  it('rejects non-https schemes', async () => {
    await expect(
      assertPublicWebhookUrl('http://integrator.example.com/hooks', publicLookup),
    ).rejects.toThrow(WebhookUrlValidationError);
    await expect(
      assertPublicWebhookUrl('http://integrator.example.com/hooks', publicLookup),
    ).rejects.toThrow(/https scheme/i);
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects loopback destinations (literal IP)', async () => {
    await expect(
      assertPublicWebhookUrl('https://127.0.0.1/hooks', publicLookup),
    ).rejects.toThrow(/loopback/i);
    await expect(
      assertPublicWebhookUrl('https://[::1]/hooks', publicLookup),
    ).rejects.toThrow(/loopback/i);
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects private-range destinations', async () => {
    await expect(
      assertPublicWebhookUrl('https://10.0.0.5/hooks', publicLookup),
    ).rejects.toThrow(/private/i);
    await expect(
      assertPublicWebhookUrl('https://172.16.1.1/hooks', publicLookup),
    ).rejects.toThrow(/private/i);
    await expect(
      assertPublicWebhookUrl('https://192.168.1.10/hooks', publicLookup),
    ).rejects.toThrow(/private/i);
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects link-local destinations', async () => {
    await expect(
      assertPublicWebhookUrl('https://169.254.1.1/hooks', publicLookup),
    ).rejects.toThrow(/link-local|cloud-metadata/i);
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects cloud metadata host and address', async () => {
    await expect(
      assertPublicWebhookUrl('https://169.254.169.254/latest/meta-data', publicLookup),
    ).rejects.toThrow(/link-local|cloud-metadata/i);
    await expect(
      assertPublicWebhookUrl(
        'https://metadata.google.internal/computeMetadata/v1/',
        publicLookup,
      ),
    ).rejects.toThrow(/cloud metadata/i);
    expect(publicLookup).not.toHaveBeenCalled();
  });

  it('rejects when DNS resolves to a blocked address (hostname path)', async () => {
    const lookup = jest.fn(async () => ['10.1.2.3']);
    await expect(
      assertPublicWebhookUrl('https://evil.example.com/hooks', lookup),
    ).rejects.toThrow(/private/i);
  });

  it('rejects when any of multiple DNS answers is blocked', async () => {
    const lookup = jest.fn(async () => ['93.184.216.34', '127.0.0.1']);
    await expect(
      assertPublicWebhookUrl('https://dual.example.com/hooks', lookup),
    ).rejects.toThrow(/loopback/i);
  });

  it('rejects credentials in the URL', async () => {
    await expect(
      assertPublicWebhookUrl(
        'https://user:pass@integrator.example.com/hooks',
        publicLookup,
      ),
    ).rejects.toThrow(/credentials/i);
  });
});
