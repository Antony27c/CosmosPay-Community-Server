import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService } from '@nestjs/terminus';
import { AppConfig, StellarNetwork } from '../config/configuration';
import { StellarService } from '../stellar/stellar.service';

const NETWORKS: StellarNetwork[] = ['testnet', 'public'];

/**
 * Readiness check against each configured Horizon. Uses StellarService.call()
 * so the probe shares timeout / 503 mapping with the rest of the service.
 */
@Injectable()
export class StellarHealthIndicator {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly stellar: StellarService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  checks() {
    return NETWORKS.map((network) => () => this.ping(network));
  }

  async ping(network: StellarNetwork) {
    const session = this.indicator.check(`horizon.${network}`);
    const url = this.config.get('stellar', { infer: true }).horizon[network];
    try {
      await this.stellar.call(network, (server) => server.root(), {
        maxAttempts: 1,
      });
      return session.up({ network, url });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Horizon unreachable';
      return session.down({ network, url, message });
    }
  }
}
