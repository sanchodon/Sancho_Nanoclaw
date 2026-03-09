import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { pipeline } from 'stream/promises';

import { messagingApi, validateSignature, webhook } from '@line/bot-sdk';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  LINE_IMAGE_PUBLIC_BASE_URL,
} from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface LineChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class LineChannel implements Channel {
  name = 'line';

  private connected = false;
  private server: http.Server | null = null;
  private servedFiles: Map<string, string> = new Map(); // token -> hostPath
  private client: messagingApi.MessagingApiClient | null = null;
  private blobClient: messagingApi.MessagingApiBlobClient | null = null;
  private imageBaseUrl = LINE_IMAGE_PUBLIC_BASE_URL;

  private channelSecret: string;
  private channelAccessToken: string;
  private port: number;

  private opts: LineChannelOpts;

  constructor(opts: LineChannelOpts) {
    const env = readEnvFile([
      'LINE_CHANNEL_SECRET',
      'LINE_CHANNEL_ACCESS_TOKEN',
      'LINE_WEBHOOK_PORT',
    ]);
    this.channelSecret = env.LINE_CHANNEL_SECRET || '';
    this.channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN || '';
    this.port = parseInt(env.LINE_WEBHOOK_PORT || '3000', 10);
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!this.channelSecret || !this.channelAccessToken) {
      throw new Error(
        'LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN must be set in .env',
      );
    }

    this.client = new messagingApi.MessagingApiClient({
      channelAccessToken: this.channelAccessToken,
    });
    this.blobClient = new messagingApi.MessagingApiBlobClient({
      channelAccessToken: this.channelAccessToken,
    });

    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        // Image serving: GET /images/:token
        if (req.method === 'GET' && req.url?.startsWith('/images/')) {
          const token = req.url.slice('/images/'.length);
          const filePath = token ? this.servedFiles.get(token) : undefined;
          if (!filePath) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          res.writeHead(200);
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        if (req.method !== 'POST' || req.url !== '/webhook') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          const signature = req.headers['x-line-signature'] as string;

          if (
            !signature ||
            !validateSignature(rawBody, this.channelSecret, signature)
          ) {
            logger.warn('Invalid LINE webhook signature, rejecting request');
            res.writeHead(401);
            res.end('Unauthorized');
            return;
          }

          // Respond 200 immediately — LINE requires a fast ack
          res.writeHead(200);
          res.end('OK');

          let body: webhook.CallbackRequest;
          try {
            body = JSON.parse(rawBody.toString('utf-8'));
          } catch (err) {
            logger.error({ err }, 'Failed to parse LINE webhook body');
            return;
          }

          this.handleEvents(body).catch((err) =>
            logger.error({ err }, 'Error handling LINE webhook events'),
          );
        });
        req.on('error', (err) => {
          logger.error({ err }, 'LINE webhook request error');
          res.writeHead(500);
          res.end();
        });
      });

      this.server.listen(this.port, () => {
        this.connected = true;
        this.resolveImageBaseUrl().then(() => {
          logger.info(
            { port: this.port, imageBaseUrl: this.imageBaseUrl || '(none)' },
            'LINE webhook server listening (images served at /images/:token)',
          );
        });
        resolve();
      });

      this.server.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Resolve the public base URL for image serving.
   * Uses LINE_IMAGE_PUBLIC_BASE_URL from config if set; otherwise auto-detects
   * from the running ngrok tunnel (http://localhost:4040/api/tunnels).
   */
  private async resolveImageBaseUrl(): Promise<void> {
    if (this.imageBaseUrl) return; // already configured
    try {
      const res = await fetch('http://localhost:4040/api/tunnels');
      if (!res.ok) return;
      const data = (await res.json()) as { tunnels: { public_url: string }[] };
      const httpsUrl = data.tunnels?.find((t) => t.public_url.startsWith('https://'))?.public_url;
      if (httpsUrl) {
        this.imageBaseUrl = httpsUrl;
        logger.info({ imageBaseUrl: httpsUrl }, 'Auto-detected ngrok URL for LINE image serving');
      }
    } catch {
      // ngrok not running — imageBaseUrl stays empty, sendFile will warn
    }
  }

  private async handleEvents(body: webhook.CallbackRequest): Promise<void> {
    for (const event of body.events) {
      // Log every event unconditionally for debugging
      logger.info(
        { type: event.type, source: event.source, webhookEventId: event.webhookEventId },
        'LINE event received',
      );

      if (event.type !== 'message') continue;
      const msgEvent = event as webhook.MessageEvent;

      logger.info(
        { messageType: msgEvent.message.type, source: msgEvent.source },
        'LINE message event',
      );

      // Mark as read immediately so the sender sees the "Read" receipt
      const markAsReadToken = (msgEvent.message as { markAsReadToken?: string }).markAsReadToken;
      if (markAsReadToken && this.client) {
        this.client
          .markMessagesAsReadByToken({ markAsReadToken })
          .catch((err) => logger.warn({ err }, 'Failed to mark LINE message as read'));
      }

      const { type: msgType } = msgEvent.message;
      if (msgType !== 'text' && msgType !== 'image') continue;

      const source = msgEvent.source;
      if (!source) continue;

      const chatJid =
        source.type === 'group'
          ? (source as webhook.GroupSource).groupId
          : source.type === 'room'
            ? (source as webhook.RoomSource).roomId
            : (source as webhook.UserSource).userId || '';

      if (!chatJid) continue;

      const senderId =
        source.type === 'user'
          ? (source as webhook.UserSource).userId || ''
          : (source as webhook.GroupSource | webhook.RoomSource).userId || '';

      const timestamp = new Date(msgEvent.timestamp).toISOString();
      const isGroup = source.type === 'group' || source.type === 'room';

      logger.info(
        { chatJid, senderId, msgType, isGroup },
        'LINE message — checking registration',
      );

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'line', isGroup);

      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) {
        logger.warn(
          { chatJid, registeredJids: Object.keys(groups) },
          'LINE chat not registered — message dropped',
        );
        continue;
      }

      // Resolve message content (text inline, image saved to disk)
      let content: string;
      if (msgType === 'text') {
        content = (msgEvent.message as webhook.TextMessageContent).text;
      } else {
        // image — download to the group folder so the agent can read it
        const imageContent = await this.downloadImage(
          msgEvent.message.id,
          groups[chatJid].folder,
        );
        if (!imageContent) continue; // download failed, error already logged
        content = imageContent;
      }

      // Fetch display name best-effort; fall back to userId
      let senderName = senderId;
      if (senderId && this.client) {
        try {
          const profile = await this.client.getProfile(senderId);
          senderName = profile.displayName;
        } catch {
          // Non-critical — userId is a usable fallback
        }
      }

      const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
        ? false // LINE bots never receive their own pushed messages via webhook
        : content.startsWith(`${ASSISTANT_NAME}:`);

      this.opts.onMessage(chatJid, {
        id: msgEvent.webhookEventId || msgEvent.message.id,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: isBotMessage,
      });
    }
  }

  /**
   * Download an image from LINE's content API and save it to the group folder.
   * Returns the content string to embed in the message (a path the agent can read),
   * or null if the download failed.
   */
  private async downloadImage(
    messageId: string,
    groupFolder: string,
  ): Promise<string | null> {
    if (!this.blobClient) {
      logger.warn({ messageId }, 'LINE blob client not initialized');
      return null;
    }

    const imagesDir = path.join(GROUPS_DIR, groupFolder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    try {
      const { httpResponse, body: stream } =
        await this.blobClient.getMessageContentWithHttpInfo(messageId);

      const contentType = httpResponse.headers.get('content-type') ?? '';
      const ext =
        contentType === 'image/png'
          ? '.png'
          : contentType === 'image/gif'
            ? '.gif'
            : contentType === 'image/webp'
              ? '.webp'
              : '.jpg'; // default: LINE sends JPEG

      const filename = `${messageId}${ext}`;
      const filePath = path.join(imagesDir, filename);
      const containerPath = `/workspace/group/images/${filename}`;

      await pipeline(stream, fs.createWriteStream(filePath));
      logger.info({ messageId, filePath, contentType }, 'LINE image saved');

      return `[image: ${containerPath}]`;
    } catch (err) {
      logger.error({ messageId, groupFolder, err }, 'Failed to download LINE image');
      return null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn({ jid }, 'LINE client not initialized, cannot send message');
      return;
    }

    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    const LINE_TEXT_LIMIT = 5000;
    if (prefixed.length > LINE_TEXT_LIMIT) {
      logger.warn(
        { jid, length: prefixed.length, limit: LINE_TEXT_LIMIT },
        'LINE message exceeds 5000-char limit, truncating',
      );
    }
    const payload = prefixed.slice(0, LINE_TEXT_LIMIT);

    logger.debug({ jid, length: payload.length }, 'Sending LINE push message');

    try {
      await this.client.pushMessage({
        to: jid,
        messages: [{ type: 'text', text: payload }],
      });
      logger.info({ jid, length: payload.length }, 'LINE message sent');
    } catch (err: unknown) {
      // Extract LINE API error details from HTTPFetchError
      const statusCode = (err as { statusCode?: number }).statusCode;
      const body = (err as { body?: string }).body;
      logger.error(
        { jid, statusCode, body, err },
        'Failed to send LINE push message',
      );
      throw err;
    }
  }

  async sendFile(jid: string, localPath: string, caption?: string, mimeType?: string): Promise<void> {
    if (!this.client) {
      logger.warn({ jid }, 'LINE client not initialized, cannot send file');
      return;
    }
    if (!this.imageBaseUrl) {
      // Last-chance attempt — ngrok may have started after connect()
      await this.resolveImageBaseUrl();
    }
    if (!this.imageBaseUrl) {
      logger.warn({ jid }, 'LINE_IMAGE_PUBLIC_BASE_URL not configured and ngrok not detected — skipping sendFile');
      return;
    }
    if (!fs.existsSync(localPath)) {
      logger.warn({ jid, localPath }, 'File not found, cannot send');
      return;
    }

    const ext = path.extname(localPath).toLowerCase();
    const resolvedMime =
      mimeType ||
      (ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : 'image/jpeg');

    if (!resolvedMime.startsWith('image/')) {
      logger.warn({ jid, resolvedMime }, 'Only image/* MIME types supported for LINE sendFile');
      return;
    }

    const token = crypto.randomUUID();
    this.servedFiles.set(token, localPath);
    // Auto-cleanup after 2 minutes — LINE CDN fetches immediately after push
    setTimeout(() => this.servedFiles.delete(token), 120_000);

    const imageUrl = `${this.imageBaseUrl}/images/${token}`;
    const messages: Parameters<typeof this.client.pushMessage>[0]['messages'] = [
      { type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl },
    ];
    if (caption) {
      messages.push({ type: 'text', text: caption });
    }

    try {
      await this.client.pushMessage({ to: jid, messages });
      logger.info({ jid, localPath }, 'LINE image sent');
    } catch (err) {
      this.servedFiles.delete(token);
      logger.error({ jid, localPath, err }, 'Failed to send LINE image');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * LINE IDs: groupId = C + 32 hex, userId = U + 32 hex, roomId = R + 32 hex
   */
  ownsJid(jid: string): boolean {
    return /^[CUR][0-9a-f]{32}$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
  }
}
