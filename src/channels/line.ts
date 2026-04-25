import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { pipeline } from 'stream/promises';

import { messagingApi, validateSignature, webhook } from '@line/bot-sdk';

import {
  ASSISTANT_HAS_OWN_NUMBER,
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
  onAutoRegisterDM?: (chatJid: string, lineChannelSecret: string) => void;
  onAutoRegisterGroup?: (chatJid: string, lineChannelSecret: string) => void;
}

interface SubChannel {
  secret: string;
  client: messagingApi.MessagingApiClient;
  blobClient: messagingApi.MessagingApiBlobClient;
}

export class LineChannel implements Channel {
  name = 'line';

  private connected = false;
  private server: http.Server | null = null;
  private servedFiles: Map<string, string> = new Map(); // token -> hostPath
  private servedDownloads: Map<string, { hostPath: string; fileName: string }> =
    new Map(); // token -> {hostPath, fileName}
  private client: messagingApi.MessagingApiClient | null = null;
  private blobClient: messagingApi.MessagingApiBlobClient | null = null;
  private imageBaseUrl = LINE_IMAGE_PUBLIC_BASE_URL;

  private channelSecret: string;
  private channelAccessToken: string;
  private port: number;

  private opts: LineChannelOpts;

  // Track reply tokens per chat JID (free replies expire after 60 seconds)
  private replyTokens: Map<string, { token: string; expiresAt: number }> =
    new Map();

  // Multi-channel support: additional LINE bots (e.g. Maria_Marketer)
  private subChannels: SubChannel[] = [];
  // Maps chatJid -> SubChannel so outbound messages use the correct bot
  private chatClients: Map<string, SubChannel> = new Map();
  // Maps channel secret -> SubChannel for fast lookup
  private secretToSubChannel: Map<string, SubChannel> = new Map();

  constructor(opts: LineChannelOpts) {
    const env = readEnvFile([
      'LINE_CHANNEL_SECRET',
      'LINE_CHANNEL_ACCESS_TOKEN',
      'LINE_WEBHOOK_PORT',
      'LINE_MARIA_CHANNEL_SECRET',
      'LINE_MARIA_CHANNEL_ACCESS_TOKEN',
      'LINE_NADIA_CHANNEL_SECRET',
      'LINE_NADIA_CHANNEL_ACCESS_TOKEN',
      'LINE_ANAN_CHANNEL_SECRET',
      'LINE_ANAN_CHANNEL_ACCESS_TOKEN',
      'LINE_NUMFON_CHANNEL_SECRET',
      'LINE_NUMFON_CHANNEL_ACCESS_TOKEN',
    ]);
    this.channelSecret = env.LINE_CHANNEL_SECRET || '';
    this.channelAccessToken = env.LINE_CHANNEL_ACCESS_TOKEN || '';
    this.port = parseInt(env.LINE_WEBHOOK_PORT || '3000', 10);
    this.opts = opts;

    // Register additional channels from env (LINE_MARIA_*, LINE_NADIA_*, etc.)
    const extraSecrets = [
      env.LINE_MARIA_CHANNEL_SECRET,
      env.LINE_NADIA_CHANNEL_SECRET,
      env.LINE_ANAN_CHANNEL_SECRET,
      env.LINE_NUMFON_CHANNEL_SECRET,
    ].filter(Boolean);
    const extraTokens = [
      env.LINE_MARIA_CHANNEL_ACCESS_TOKEN,
      env.LINE_NADIA_CHANNEL_ACCESS_TOKEN,
      env.LINE_ANAN_CHANNEL_ACCESS_TOKEN,
      env.LINE_NUMFON_CHANNEL_ACCESS_TOKEN,
    ].filter(Boolean);
    this._extraChannelConfigs = extraSecrets.map((s, i) => ({
      secret: s!,
      accessToken: extraTokens[i] || '',
    }));
  }

  private _extraChannelConfigs: { secret: string; accessToken: string }[] = [];

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

    // Initialize extra sub-channels
    for (const cfg of this._extraChannelConfigs) {
      if (cfg.secret && cfg.accessToken) {
        const sc: SubChannel = {
          secret: cfg.secret,
          client: new messagingApi.MessagingApiClient({
            channelAccessToken: cfg.accessToken,
          }),
          blobClient: new messagingApi.MessagingApiBlobClient({
            channelAccessToken: cfg.accessToken,
          }),
        };
        this.subChannels.push(sc);
        this.secretToSubChannel.set(cfg.secret, sc);
        logger.info('Additional LINE channel registered');
      }
    }

    // Rebuild chatClients from registered groups that declare a lineChannelSecret
    const groups = this.opts.registeredGroups();
    for (const [jid, group] of Object.entries(groups)) {
      const secret = group.containerConfig?.lineChannelSecret;
      if (secret) {
        const sc = this.secretToSubChannel.get(secret);
        if (sc) {
          this.chatClients.set(jid, sc);
          logger.info(
            { jid, name: group.name },
            'Restored LINE sub-channel mapping for group',
          );
        }
      }
    }

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
          const ext = path.extname(filePath).toLowerCase();
          const contentType =
            ext === '.png'
              ? 'image/png'
              : ext === '.gif'
                ? 'image/gif'
                : ext === '.webp'
                  ? 'image/webp'
                  : 'image/jpeg';
          res.writeHead(200, { 'Content-Type': contentType });
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        // File download page: GET /files/:token → HTML auto-download page
        if (
          req.method === 'GET' &&
          req.url?.startsWith('/files/') &&
          !req.url.startsWith('/files-raw/')
        ) {
          const token = req.url.slice('/files/'.length);
          const entry = token ? this.servedDownloads.get(token) : undefined;
          if (!entry || !fs.existsSync(entry.hostPath)) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          // Serve an HTML page that auto-downloads via fetch (bypasses ngrok warning for XHR)
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Downloading ${entry.fileName}...</title>
<style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f5f5f5}
.box{background:#fff;border-radius:12px;padding:40px;display:inline-block;box-shadow:0 2px 12px rgba(0,0,0,.1)}
button{background:#06c755;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;cursor:pointer;margin-top:16px}</style></head>
<body><div class="box"><h2>📊 ${entry.fileName}</h2><p id="status">กำลังดาวน์โหลด...</p>
<button id="btn" style="display:none" onclick="download()">📥 ดาวน์โหลดอีกครั้ง</button></div>
<script>
function download(){
  fetch('/files-raw/${token}',{headers:{'ngrok-skip-browser-warning':'1'}})
    .then(r=>r.blob()).then(blob=>{
      const a=document.createElement('a');a.href=URL.createObjectURL(blob);
      a.download='${entry.fileName}';document.body.appendChild(a);a.click();
      document.getElementById('status').textContent='ดาวน์โหลดสำเร็จ ✅';
      document.getElementById('btn').style.display='inline-block';
    }).catch(()=>{document.getElementById('status').textContent='เกิดข้อผิดพลาด กรุณาลองใหม่';
      document.getElementById('btn').style.display='inline-block';});
}
download();
</script></body></html>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        // Raw file bytes: GET /files-raw/:token (used by the HTML page via fetch — no ngrok warning)
        if (req.method === 'GET' && req.url?.startsWith('/files-raw/')) {
          const token = req.url.slice('/files-raw/'.length);
          const entry = token ? this.servedDownloads.get(token) : undefined;
          if (!entry || !fs.existsSync(entry.hostPath)) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          const ext = path.extname(entry.fileName).toLowerCase();
          const contentType =
            ext === '.xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : ext === '.csv'
                ? 'text/csv'
                : ext === '.pdf'
                  ? 'application/pdf'
                  : 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${entry.fileName}"`,
            'Access-Control-Allow-Origin': '*',
          });
          fs.createReadStream(entry.hostPath).pipe(res);
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

          if (!signature) {
            logger.warn('Missing LINE webhook signature, rejecting request');
            res.writeHead(401);
            res.end('Unauthorized');
            return;
          }

          // Try primary channel secret first, then sub-channels
          let matchedSubChannel: SubChannel | null = null;
          if (validateSignature(rawBody, this.channelSecret, signature)) {
            matchedSubChannel = null; // use primary client
          } else {
            const found = this.subChannels.find((sc) =>
              validateSignature(rawBody, sc.secret, signature),
            );
            if (found) {
              matchedSubChannel = found;
            } else {
              logger.warn('Invalid LINE webhook signature, rejecting request');
              res.writeHead(401);
              res.end('Unauthorized');
              return;
            }
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

          this.handleEvents(body, matchedSubChannel).catch((err) =>
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
      const httpsUrl = data.tunnels?.find((t) =>
        t.public_url.startsWith('https://'),
      )?.public_url;
      if (httpsUrl) {
        this.imageBaseUrl = httpsUrl;
        logger.info(
          { imageBaseUrl: httpsUrl },
          'Auto-detected ngrok URL for LINE image serving',
        );
      }
    } catch {
      // ngrok not running — imageBaseUrl stays empty, sendFile will warn
    }
  }

  private async handleEvents(
    body: webhook.CallbackRequest,
    subChannel: SubChannel | null = null,
  ): Promise<void> {
    for (const event of body.events) {
      // Log every event unconditionally for debugging
      logger.info(
        {
          type: event.type,
          source: event.source,
          webhookEventId: event.webhookEventId,
        },
        'LINE event received',
      );

      // Handle memberJoined: welcome new members with a free reply
      if (event.type === 'memberJoined') {
        const joinEvent = event as webhook.MemberJoinedEvent;
        const groupSource = joinEvent.source as webhook.GroupSource;
        const groupJid = groupSource?.groupId;
        const activeClient = subChannel?.client ?? this.client;
        if (groupJid && activeClient && joinEvent.replyToken) {
          const groups = this.opts.registeredGroups();
          const folder = groups[groupJid]?.folder ?? '';
          const particle = folder.startsWith('nadia') ? 'ค่ะ' : 'ครับ';
          // Fetch display names for all joining members
          const names: string[] = [];
          for (const member of joinEvent.joined?.members ?? []) {
            if (member.type === 'user' && member.userId) {
              try {
                const profile = await activeClient.getProfile(member.userId);
                names.push(profile.displayName);
              } catch {
                names.push(member.userId);
              }
            }
          }
          const nameList = names.length > 0 ? names.join(', ') : 'สมาชิกใหม่';
          const welcomeText = `ยินดีต้อนรับ ${nameList} เข้ากลุ่ม${particle}! 👋`;
          activeClient
            .replyMessage({
              replyToken: joinEvent.replyToken,
              messages: [{ type: 'text', text: welcomeText }],
            })
            .catch((err) =>
              logger.warn({ err }, 'Failed to send member welcome'),
            );
          logger.info({ groupJid, names }, 'Sent member welcome message');
        }
        continue;
      }

      if (event.type !== 'message') continue;
      const msgEvent = event as webhook.MessageEvent;

      logger.info(
        { messageType: msgEvent.message.type, source: msgEvent.source },
        'LINE message event',
      );

      const activeClient = subChannel?.client ?? this.client;

      const { type: msgType } = msgEvent.message;
      if (msgType !== 'text' && msgType !== 'image' && msgType !== 'file')
        continue;

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

      // Store which sub-channel owns this chatJid for outbound routing
      if (subChannel && !this.chatClients.has(chatJid)) {
        this.chatClients.set(chatJid, subChannel);
      }

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'line', isGroup);

      let groups = this.opts.registeredGroups();
      if (!groups[chatJid]) {
        // Auto-register 1-on-1 DMs for sub-channels (e.g. Maria_Marketer, Nadia)
        if (
          subChannel &&
          source.type === 'user' &&
          this.opts.onAutoRegisterDM
        ) {
          this.opts.onAutoRegisterDM(chatJid, subChannel.secret);
          groups = this.opts.registeredGroups(); // re-fetch after registration
        }
        // Auto-register group chats for sub-channels
        if (
          !groups[chatJid] &&
          subChannel &&
          (source.type === 'group' || source.type === 'room') &&
          this.opts.onAutoRegisterGroup
        ) {
          this.opts.onAutoRegisterGroup(chatJid, subChannel.secret);
          groups = this.opts.registeredGroups(); // re-fetch after registration
        }
        if (!groups[chatJid]) {
          logger.warn(
            { chatJid, registeredJids: Object.keys(groups) },
            'LINE chat not registered — message dropped',
          );
          continue;
        }
      }

      // Resolve message content (text inline, image/file saved to disk)
      let content: string;
      if (msgType === 'text') {
        content = (msgEvent.message as webhook.TextMessageContent).text;
      } else if (msgType === 'file') {
        const fileMsg = msgEvent.message as webhook.FileMessageContent;
        const fileContent = await this.downloadFile(
          fileMsg.id,
          fileMsg.fileName,
          groups[chatJid].folder,
          subChannel,
        );
        if (!fileContent) continue;
        content = fileContent;
      } else {
        // image — download to the group folder so the agent can read it
        const imageContent = await this.downloadImage(
          msgEvent.message.id,
          groups[chatJid].folder,
          subChannel,
        );
        if (!imageContent) continue; // download failed, error already logged
        content = imageContent;
      }

      // Fetch display name best-effort; fall back to userId
      let senderName = senderId;
      if (senderId && activeClient) {
        try {
          const profile = await activeClient.getProfile(senderId);
          senderName = profile.displayName;
        } catch {
          // Non-critical — userId is a usable fallback
        }
      }

      // LINE Official Account never receives its own messages via webhook
      const isBotMessage = false;

      const replyToken = msgEvent.replyToken || undefined;

      // Store reply token for 60-second window (free reply API)
      if (replyToken) {
        this.replyTokens.set(chatJid, {
          token: replyToken,
          expiresAt: Date.now() + 59000, // Expire at 59 seconds to be safe
        });
        logger.debug({ chatJid }, 'Stored reply token (free 60-second window)');
      }

      this.opts.onMessage(chatJid, {
        id: msgEvent.webhookEventId || msgEvent.message.id,
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        is_bot_message: isBotMessage,
        reply_token: replyToken,
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
    subChannel: SubChannel | null = null,
  ): Promise<string | null> {
    const activeBlobClient = subChannel?.blobClient ?? this.blobClient;
    if (!activeBlobClient) {
      logger.warn({ messageId }, 'LINE blob client not initialized');
      return null;
    }

    const imagesDir = path.join(GROUPS_DIR, groupFolder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });

    try {
      const { httpResponse, body: stream } =
        await activeBlobClient.getMessageContentWithHttpInfo(messageId);

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
      logger.error(
        { messageId, groupFolder, err },
        'Failed to download LINE image',
      );
      return null;
    }
  }

  private async downloadFile(
    messageId: string,
    fileName: string,
    groupFolder: string,
    subChannel?: {
      client: messagingApi.MessagingApiClient;
      blobClient: messagingApi.MessagingApiBlobClient;
      secret: string;
    } | null,
  ): Promise<string | null> {
    const activeBlobClient = subChannel?.blobClient ?? this.blobClient;
    if (!activeBlobClient) {
      logger.warn({ messageId }, 'LINE blob client not initialized');
      return null;
    }

    const filesDir = path.join(GROUPS_DIR, groupFolder, 'files');
    fs.mkdirSync(filesDir, { recursive: true });

    try {
      const { body: stream } =
        await activeBlobClient.getMessageContentWithHttpInfo(messageId);

      // Use original filename, sanitized
      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(filesDir, safeFileName);
      const containerPath = `/workspace/group/files/${safeFileName}`;

      await pipeline(stream, fs.createWriteStream(filePath));
      logger.info({ messageId, filePath, fileName }, 'LINE file saved');

      return `[file saved: ${containerPath}]\nPlease read this file and process its contents.`;
    } catch (err) {
      logger.error(
        { messageId, groupFolder, fileName, err },
        'Failed to download LINE file',
      );
      return null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const activeClient = this.chatClients.get(jid)?.client ?? this.client;
    if (!activeClient) {
      logger.warn({ jid }, 'LINE client not initialized, cannot send message');
      return;
    }

    const LINE_TEXT_LIMIT = 5000;
    if (text.length > LINE_TEXT_LIMIT) {
      logger.warn(
        { jid, length: text.length, limit: LINE_TEXT_LIMIT },
        'LINE message exceeds 5000-char limit, truncating',
      );
    }
    const payload = text.slice(0, LINE_TEXT_LIMIT);

    // Try free reply API first (60-second window)
    const replyTokenData = this.replyTokens.get(jid);
    if (replyTokenData && replyTokenData.expiresAt > Date.now()) {
      logger.debug(
        { jid, length: payload.length },
        'Sending LINE reply message (FREE)',
      );
      try {
        await activeClient.replyMessage({
          replyToken: replyTokenData.token,
          messages: [{ type: 'text', text: payload }],
        });
        logger.info(
          { jid, length: payload.length },
          'LINE message sent via reply (FREE - no quota)',
        );
        this.replyTokens.delete(jid); // Token used, remove it
        return;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        const body = (err as { body?: string }).body;
        logger.warn(
          { jid, statusCode, body },
          'Failed to send reply message, falling back to push',
        );
        this.replyTokens.delete(jid); // Token expired or invalid
      }
    }

    // Fall back to push API (costs quota)
    logger.debug(
      { jid, length: payload.length },
      'Sending LINE push message (quota)',
    );

    try {
      await activeClient.pushMessage({
        to: jid,
        messages: [{ type: 'text', text: payload }],
      });
      logger.info(
        { jid, length: payload.length },
        'LINE message sent via push (costs quota)',
      );
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

  async sendFile(
    jid: string,
    localPath: string,
    caption?: string,
    mimeType?: string,
  ): Promise<void> {
    const activeClient = this.chatClients.get(jid)?.client ?? this.client;
    if (!activeClient) {
      logger.warn({ jid }, 'LINE client not initialized, cannot send file');
      return;
    }
    if (!this.imageBaseUrl) {
      // Last-chance attempt — ngrok may have started after connect()
      await this.resolveImageBaseUrl();
    }
    if (!this.imageBaseUrl) {
      logger.warn(
        { jid },
        'LINE_IMAGE_PUBLIC_BASE_URL not configured and ngrok not detected — skipping sendFile',
      );
      return;
    }
    if (!fs.existsSync(localPath)) {
      logger.warn({ jid, localPath }, 'File not found, cannot send');
      return;
    }

    const ext = path.extname(localPath).toLowerCase();
    const resolvedMime =
      mimeType ||
      (ext === '.png'
        ? 'image/png'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.xlsx'
              ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
              : ext === '.csv'
                ? 'text/csv'
                : ext === '.pdf'
                  ? 'application/pdf'
                  : 'image/jpeg');

    // Non-image files: send Flex Message with a download button
    if (!resolvedMime.startsWith('image/')) {
      const fileName = path.basename(localPath);
      const token = crypto.randomUUID();
      this.servedDownloads.set(token, { hostPath: localPath, fileName });
      // Auto-cleanup after 30 minutes
      setTimeout(() => this.servedDownloads.delete(token), 30 * 60 * 1000);

      const downloadUrl = `${this.imageBaseUrl}/files/${token}`;
      const label = caption || `📥 ดาวน์โหลด ${fileName}`;

      const flexMessage = {
        type: 'flex' as const,
        altText: label,
        contents: {
          type: 'bubble' as const,
          body: {
            type: 'box' as const,
            layout: 'vertical' as const,
            contents: [
              {
                type: 'text' as const,
                text: '📊 รายงาน Excel',
                weight: 'bold' as const,
                size: 'lg' as const,
              },
              {
                type: 'text' as const,
                text: fileName,
                size: 'sm' as const,
                color: '#888888',
                wrap: true,
              },
            ],
          },
          footer: {
            type: 'box' as const,
            layout: 'vertical' as const,
            contents: [
              {
                type: 'button' as const,
                style: 'primary' as const,
                action: {
                  type: 'uri' as const,
                  label: '📥 ดาวน์โหลด',
                  uri: downloadUrl,
                },
              },
            ],
          },
        },
      };

      const replyTokenData = this.replyTokens.get(jid);
      if (replyTokenData && replyTokenData.expiresAt > Date.now()) {
        try {
          await activeClient.replyMessage({
            replyToken: replyTokenData.token,
            messages: [flexMessage],
          });
          this.replyTokens.delete(jid);
          logger.info(
            { jid, fileName },
            'LINE download button sent via reply (FREE)',
          );
          return;
        } catch {
          this.replyTokens.delete(jid);
        }
      }
      await activeClient.pushMessage({ to: jid, messages: [flexMessage] });
      logger.info({ jid, fileName }, 'LINE download button sent via push');
      return;
    }

    const token = crypto.randomUUID();
    this.servedFiles.set(token, localPath);
    // Auto-cleanup after 2 minutes — LINE CDN fetches immediately after push
    setTimeout(() => this.servedFiles.delete(token), 120_000);

    const imageUrl = `${this.imageBaseUrl}/images/${token}`;
    const messages: Parameters<typeof activeClient.pushMessage>[0]['messages'] =
      [
        {
          type: 'image',
          originalContentUrl: imageUrl,
          previewImageUrl: imageUrl,
        },
      ];
    if (caption) {
      messages.push({ type: 'text', text: caption });
    }

    // Try free reply API first (60-second window)
    const replyTokenData = this.replyTokens.get(jid);
    if (replyTokenData && replyTokenData.expiresAt > Date.now()) {
      logger.debug({ jid, localPath }, 'Sending LINE image via reply (FREE)');
      try {
        await activeClient.replyMessage({
          replyToken: replyTokenData.token,
          messages,
        });
        logger.info(
          { jid, localPath },
          'LINE image sent via reply (FREE - no quota)',
        );
        this.replyTokens.delete(jid);
        return;
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        logger.warn(
          { jid, statusCode },
          'Failed to send reply image, falling back to push',
        );
        this.replyTokens.delete(jid);
      }
    }

    // Fall back to push API (costs quota)
    logger.debug({ jid, localPath }, 'Sending LINE image via push (quota)');

    try {
      await activeClient.pushMessage({ to: jid, messages });
      logger.info({ jid, localPath }, 'LINE image sent via push (costs quota)');
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
