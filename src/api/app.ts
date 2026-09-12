import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/pool.js';
import type { Logger } from '../infrastructure/logger.js';
import { AppError } from './errors.js';
import type { AuthService } from '../auth/types.js';
import type { FollowedTraderService } from '../traders/types.js';

export interface AppDependencies {
  database: Pick<Database, 'healthCheck'>;
  logger: Logger;
  auth?: AuthService;
  traders?: FollowedTraderService;
  requestId?: () => string;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, requestId: string): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-request-id', requestId);
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 16_384) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must be a JSON object');
  }
}

function requiredAuth(auth: AuthService | undefined): AuthService {
  if (!auth) throw new AppError(503, 'AUTH_UNAVAILABLE', 'Authentication is unavailable');
  return auth;
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHORIZED', 'A bearer token is required');
  return header.slice(7).trim();
}

async function authenticatedUser(auth: AuthService | undefined, request: IncomingMessage) {
  const user = await requiredAuth(auth).authenticate(bearerToken(request));
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  return user;
}

function requiredTraders(traders: FollowedTraderService | undefined): FollowedTraderService {
  if (!traders) throw new AppError(503, 'TRADER_SERVICE_UNAVAILABLE', 'Trader service is unavailable');
  return traders;
}

export function createApp(dependencies: AppDependencies) {
  return async function app(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = request.headers['x-request-id']?.toString() || (dependencies.requestId ?? randomUUID)();
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');

    try {
      if (request.url === '/health') {
        if (request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only GET requests are supported');
        sendJson(response, 200, { status: 'ok' }, requestId);
        return;
      }

      if (request.url === '/ready') {
        if (request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only GET requests are supported');
        await dependencies.database.healthCheck();
        sendJson(response, 200, { status: 'ready' }, requestId);
        return;
      }

      if (request.url === '/auth/challenge') {
        if (request.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only POST requests are supported');
        const body = await readJson(request);
        const result = await requiredAuth(dependencies.auth).createChallenge(body.walletAddress as string);
        sendJson(response, 201, result, requestId);
        return;
      }

      if (request.url === '/auth/verify') {
        if (request.method !== 'POST') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only POST requests are supported');
        const body = await readJson(request);
        const result = await requiredAuth(dependencies.auth).verifyChallenge({
          challengeId: body.challengeId as string,
          walletAddress: body.walletAddress as string,
          signature: body.signature as string
        });
        sendJson(response, 200, result, requestId);
        return;
      }

      if (request.url === '/auth/me') {
        if (request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only GET requests are supported');
        const user = await authenticatedUser(dependencies.auth, request);
        sendJson(response, 200, user, requestId);
        return;
      }

      if (request.url === '/followed-traders') {
        const user = await authenticatedUser(dependencies.auth, request);
        const traders = requiredTraders(dependencies.traders);
        if (request.method === 'GET') {
          sendJson(response, 200, { traders: await traders.list(user.userId) }, requestId);
          return;
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          sendJson(response, 201, await traders.follow(user.userId, body.traderWalletAddress as string), requestId);
          return;
        }
        throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only GET and POST requests are supported');
      }

      const followedMatch = request.url?.match(/^\/followed-traders\/([^/]+)(?:\/settings)?$/);
      if (followedMatch) {
        const user = await authenticatedUser(dependencies.auth, request);
        const traders = requiredTraders(dependencies.traders);
        const followedTraderId = followedMatch[1];
        if (!followedTraderId) throw new AppError(400, 'INVALID_ID', 'A followed trader ID is required');
        if (request.url?.endsWith('/settings')) {
          if (request.method !== 'PUT') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only PUT requests are supported');
          sendJson(response, 200, await traders.updateSettings(user.userId, followedTraderId, await readJson(request)), requestId);
          return;
        }
        if (request.method !== 'DELETE') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only DELETE requests are supported');
        await traders.remove(user.userId, followedTraderId);
        sendJson(response, 204, null, requestId);
        return;
      }

      throw new AppError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(503, 'SERVICE_UNAVAILABLE', 'Service unavailable');
      if (!(error instanceof AppError)) {
        dependencies.logger.error('Unhandled request error', { requestId, error: error instanceof Error ? error.message : 'unknown' });
      }
      sendJson(response, appError.statusCode, { error: { code: appError.code, message: appError.message, requestId } }, requestId);
    }
  };
}
