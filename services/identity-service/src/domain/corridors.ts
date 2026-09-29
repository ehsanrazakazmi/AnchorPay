// Where recipients can be (DECISIONS D-31): read from fx-service's corridor configuration, so a corridor an
// admin disables or changes stops accepting new recipients without a code change here.
import { AppError, InternalClient } from '@anchorpay/service-kit';

export interface Destination {
  country: string;
  currency: string;
  payoutMethods: string[];
  enabled: boolean;
}

export interface CorridorCatalog {
  destinations(requestId: string): Promise<Destination[]>;
}

interface CorridorApi {
  receiveCountry: string;
  receiveCurrency: string;
  payoutMethods: string[];
  enabled: boolean;
}

/** fx-service's /internal/fx/corridors, cached for 5 minutes; serves the last good list if fx-service is down. */
export class HttpCorridorCatalog implements CorridorCatalog {
  private cache: { at: number; value: Destination[] } | undefined;
  private readonly client = new InternalClient('identity-service');
  private readonly ttlMs: number;
  private readonly baseUrl: string | undefined;

  constructor(options: { ttlMs?: number; baseUrl?: string } = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.baseUrl = options.baseUrl;
  }

  async destinations(requestId: string): Promise<Destination[]> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    try {
      const res = await this.client.call<{ data: CorridorApi[] }>('fx-service', 'GET', '/internal/fx/corridors', {
        requestId, retries: 1, ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      });
      const value = res.body.data.map((c) => ({
        country: c.receiveCountry, currency: c.receiveCurrency, payoutMethods: c.payoutMethods, enabled: c.enabled,
      }));
      this.cache = { at: Date.now(), value };
      return value;
    } catch (err) {
      if (this.cache) return this.cache.value; // stale but known-good beats refusing every recipient
      throw new AppError('SERVICE_UNAVAILABLE', 'Destination countries are temporarily unavailable. Please try again shortly.');
    }
  }
}

/** Fixed list (tests). */
export class StaticCorridorCatalog implements CorridorCatalog {
  private readonly list: Destination[];

  constructor(list: Destination[]) {
    this.list = list;
  }

  async destinations(): Promise<Destination[]> {
    return this.list;
  }
}

export function assertDestination(destinations: Destination[], country: string, currency: string, payoutMethod: string): void {
  const matches = destinations.filter((d) => d.country === country);
  if (matches.length === 0) throw new AppError('CORRIDOR_UNAVAILABLE', `Sending to ${country} is not available.`);
  const d = matches.find((m) => m.currency === currency);
  if (!d) {
    throw new AppError('CORRIDOR_UNAVAILABLE', `Recipients in ${country} are paid in ${matches.map((m) => m.currency).join(' or ')}, not ${currency}.`);
  }
  if (!d.enabled) throw new AppError('CORRIDOR_UNAVAILABLE', `Sending to ${country} is temporarily unavailable.`);
  if (!d.payoutMethods.includes(payoutMethod)) {
    throw new AppError('CORRIDOR_UNAVAILABLE', `${payoutMethod.replace('_', ' ')} payouts are not available for ${country}.`);
  }
}
