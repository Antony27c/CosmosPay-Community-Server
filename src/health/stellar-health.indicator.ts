import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService } from '@nestjs/terminus';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { StellarService } from '../stellar/stellar.service';

/**
 * Probe budget for readiness. The normal Horizon timeout (10s) is far above
 * typical k8s probe timeouts; a slow unused network would flap the pod.
 */
export const HORIZON_READINESS_TIMEOUT_MS = 2000;

/**
 * Readiness check against the deployment's configured Horizon
 * (`STELLAR_NETWORK`). Uses StellarService.call() so the probe shares 503
 * mapping with the rest of the service, but with a short timeout and no retry.
 */
@Injectable()
export class StellarHealthIndicator {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  checks() {
    const { network } = this.config.get('stellar', { infer: true });
    return [() => this.ping(network)];
  }

  async ping(network: StellarNetwork) {
    const session = this.indicator.check(`horizon.${network}`);
    const url = this.config.get('stellar', { infer: true }).horizon[network];
    try {
      await this.stellar.call(network, (server) => server.root(), {
        maxAttempts: 1,
        timeoutMs: HORIZON_READINESS_TIMEOUT_MS,
      });
      return session.up({ network, url });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Horizon unreachable';
      return session.down({ network, url, message });
    }
  }
}
