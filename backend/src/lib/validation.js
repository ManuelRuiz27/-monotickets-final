import { ZodError } from './zod-lite.js';

export function formatZodError(error) {
  if (!(error instanceof ZodError)) {
    return [];
  }
  return error.issues.map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path || ''),
    message: issue.message,
  }));
}

export function buildValidationError(error) {
  const details = formatZodError(error);
  return {
    statusCode: 400,
    payload: {
      error: 'invalid_request',
      details,
    },
  };
}
