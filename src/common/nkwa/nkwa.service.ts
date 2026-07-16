import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export type NkwaStatus = 'pending' | 'success' | 'failed' | 'canceled';
export type NkwaOperator = 'mtn' | 'orange';

export interface NkwaPayment {
  id: string;
  amount: number;
  currency: string;
  status: NkwaStatus;
  phoneNumber: string;
  paymentType: 'collection' | 'disbursement';
  telecomOperator: NkwaOperator;
  fee: number;
  merchantId: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Thin client for the Nkwa Pay API (https://api.pay.mynkwa.com).
 *
 * Nkwa handles MoMo (MTN Mobile Money) and Orange Money behind a single API —
 * the operator is auto-detected from the phone number. All amounts are integer
 * XAF (a zero-decimal currency — there are no cents).
 *
 * Auth: `X-API-Key` header. Set NKWA_API_KEY (sandbox first, live after KYC).
 */
@Injectable()
export class NkwaService {
  private readonly logger = new Logger(NkwaService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly webhookPublicKey?: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = (this.config.get<string>('nkwa.baseUrl') || 'https://api.pay.mynkwa.com').replace(/\/$/, '');
    this.apiKey = this.config.get<string>('nkwa.apiKey') || '';
    this.webhookPublicKey = this.config.get<string>('nkwa.webhookPublicKey') || undefined;
    if (!this.apiKey) {
      this.logger.warn('NKWA_API_KEY is not set — payment collection/disbursement will fail until configured.');
    }
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /** Collect a payment from a customer (C2B). Amount is integer XAF. */
  async collect(amountXaf: number, phoneNumber: string, description?: string): Promise<NkwaPayment> {
    return this.request('POST', '/collect', {
      amount: Math.round(amountXaf),
      phoneNumber: this.normalizePhone(phoneNumber),
      ...(description ? { description } : {}),
    });
  }

  /** Disburse a payout to a customer (B2C). Amount is integer XAF. */
  async disburse(amountXaf: number, phoneNumber: string, description?: string): Promise<NkwaPayment> {
    return this.request('POST', '/disburse', {
      amount: Math.round(amountXaf),
      phoneNumber: this.normalizePhone(phoneNumber),
      ...(description ? { description } : {}),
    });
  }

  /** Fetch the authoritative current state of a payment by id. */
  async getPayment(id: string): Promise<NkwaPayment> {
    return this.request('GET', `/payments/${encodeURIComponent(id)}`);
  }

  /**
   * Verify an incoming webhook. Nkwa signs with an RSA key (public key from the
   * dashboard) sent as `X-Signature` over `${timestamp}.${rawBody}`. If no public
   * key is configured we return false so callers fall back to re-fetching the
   * payment from Nkwa (getPayment) — which is the authoritative check anyway.
   */
  verifyWebhook(signature: string | undefined, timestamp: string | undefined, rawBody: Buffer): boolean {
    if (!this.webhookPublicKey || !signature || !timestamp) return false;
    try {
      const signed = `${timestamp}.${rawBody.toString('utf8')}`;
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(signed);
      verifier.end();
      return verifier.verify(this.webhookPublicKey, Buffer.from(signature, 'base64'));
    } catch (err: any) {
      this.logger.warn(`Webhook signature verification error: ${err.message}`);
      return false;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private normalizePhone(phone: string): string {
    // Nkwa expects a full international number without '+' (e.g. 237650000000).
    const digits = (phone || '').replace(/[^\d]/g, '');
    if (digits.startsWith('237')) return digits;
    if (digits.length === 9) return `237${digits}`; // local Cameroon number
    return digits;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<NkwaPayment> {
    if (!this.apiKey) {
      throw new BadRequestException('Payments are not configured (missing NKWA_API_KEY).');
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err: any) {
      this.logger.error(`Nkwa ${method} ${path} network error: ${err.message}`);
      throw new BadRequestException('Payment provider unreachable, please try again.');
    }

    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      this.logger.error(`Nkwa ${method} ${path} failed ${res.status}: ${text}`);
      const message = json?.message || json?.error || `Payment provider error (${res.status})`;
      throw new BadRequestException(message);
    }

    return json as NkwaPayment;
  }
}
