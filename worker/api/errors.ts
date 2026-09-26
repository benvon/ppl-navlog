import type { ApiErrorCode, ApiErrorPayload } from './contracts';

export class ApiError extends Error {
  constructor(readonly message: string, readonly status: number, readonly code: ApiErrorCode, readonly diagnostic?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function errorPayload(error: ApiError, requestId: string): ApiErrorPayload {
  return { error: error.message, code: error.code, requestId };
}
