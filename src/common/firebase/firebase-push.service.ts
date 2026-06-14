import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as fs from 'fs';

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

@Injectable()
export class FirebasePushService implements OnModuleInit {
  private readonly logger = new Logger(FirebasePushService.name);
  private initialized = false;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    // Avoid double-init when hot-reloading
    if (admin.apps.length > 0) {
      this.initialized = true;
      return;
    }

    try {
      const serviceAccountPath = this.configService.get<string>('firebase.serviceAccountPath');

      if (serviceAccountPath && fs.existsSync(serviceAccountPath)) {
        // Load from a JSON file (recommended for local dev)
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
      } else {
        // Load from individual env vars (recommended for production / CI)
        const projectId   = this.configService.get<string>('firebase.projectId');
        const clientEmail = this.configService.get<string>('firebase.clientEmail');
        const privateKey  = this.configService.get<string>('firebase.privateKey');

        if (!projectId || !clientEmail || !privateKey) {
          this.logger.warn(
            'Firebase credentials not configured — push notifications disabled. ' +
            'Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_PROJECT_ID / ' +
            'FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY.',
          );
          return;
        }

        admin.initializeApp({
          credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
        });
      }

      this.initialized = true;
      this.logger.log('Firebase Admin SDK initialized ✓');
    } catch (err: any) {
      this.logger.error(`Firebase init failed: ${err.message}`);
    }
  }

  // ─── Send to a single FCM token ────────────────────────────────────────────

  async sendToToken(token: string, payload: PushPayload): Promise<boolean> {
    if (!this.initialized) return false;

    try {
      await admin.messaging().send({
        token,
        notification: {
          title: payload.title,
          body: payload.body,
          imageUrl: payload.imageUrl,
        },
        data: payload.data,
        android: {
          priority: 'high',
          notification: { sound: 'default', channelId: 'edubridge_default' },
        },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      });
      return true;
    } catch (err: any) {
      // Token expired / unregistered — caller should delete it from DB
      if (
        err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token'
      ) {
        this.logger.debug(`Stale FCM token removed: ${token.slice(0, 20)}…`);
        return false;
      }
      this.logger.warn(`FCM send failed: ${err.message}`);
      return false;
    }
  }

  // ─── Send to multiple tokens (fan-out) ─────────────────────────────────────

  async sendToTokens(
    tokens: string[],
    payload: PushPayload,
  ): Promise<{ successCount: number; staleTokens: string[] }> {
    if (!this.initialized || tokens.length === 0) {
      return { successCount: 0, staleTokens: [] };
    }

    const staleTokens: string[] = [];
    let successCount = 0;

    // FCM multicast supports up to 500 tokens per call
    const chunks = chunkArray(tokens, 500);

    for (const chunk of chunks) {
      try {
        const response = await admin.messaging().sendEachForMulticast({
          tokens: chunk,
          notification: { title: payload.title, body: payload.body, imageUrl: payload.imageUrl },
          data: payload.data,
          android: {
            priority: 'high',
            notification: { sound: 'default', channelId: 'edubridge_default' },
          },
          apns: {
            payload: { aps: { sound: 'default', badge: 1 } },
          },
        });

        successCount += response.successCount;

        response.responses.forEach((resp, idx) => {
          if (
            !resp.success &&
            (resp.error?.code === 'messaging/registration-token-not-registered' ||
              resp.error?.code === 'messaging/invalid-registration-token')
          ) {
            staleTokens.push(chunk[idx]);
          }
        });
      } catch (err: any) {
        this.logger.warn(`FCM multicast failed: ${err.message}`);
      }
    }

    return { successCount, staleTokens };
  }

  get isReady() {
    return this.initialized;
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}
