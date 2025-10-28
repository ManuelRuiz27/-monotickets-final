import { authenticateRequest } from './authorization.js';

export function createJwtAuthMiddleware({ env = process.env, logger } = {}) {
  const log = typeof logger === 'function' ? logger : (payload) => console.log(JSON.stringify(payload));

  return async function jwtAuthMiddleware(req, res, context) {
    const auth = authenticateRequest({ headers: req.headers, env });
    context.auth = auth;
    if (!context.requestId) {
      context.requestId = res.getHeader('x-request-id');
    }

    const hasTokenHeader = Boolean(req.headers?.authorization || req.headers?.Authorization);
    if (hasTokenHeader && auth.error) {
      log({
        level: 'warn',
        message: 'unauthorized_access_attempt',
        reason: auth.error,
        path: context?.url?.pathname || req.url || 'unknown',
        request_id: context?.requestId || res.getHeader('x-request-id') || null,
      });
    }
  };
}
