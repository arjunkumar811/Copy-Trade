import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Database } from '../db/pool.js';
import type { Logger } from '../infrastructure/logger.js';
import { AppError } from './errors.js';

export interface AppDependencies {
  database: Pick<Database, 'healthCheck'>;
  logger: Logger;
  requestId?: () => string;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, requestId: string): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-request-id', requestId);
  response.end(JSON.stringify(body));
}

export function createApp(dependencies: AppDependencies) {
  return async function app(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestId = request.headers['x-request-id']?.toString() || (dependencies.requestId ?? randomUUID)();
    response.setHeader('x-request-id', requestId);
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');

    try {
      if (request.method !== 'GET') {
        throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Only GET requests are supported by this foundation API');
      }

      if (request.url === '/health') {
        sendJson(response, 200, { status: 'ok' }, requestId);
        return;
      }

      if (request.url === '/ready') {
        await dependencies.database.healthCheck();
        sendJson(response, 200, { status: 'ready' }, requestId);
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
