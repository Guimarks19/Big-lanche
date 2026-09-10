const { AppError } = require('../utils/errors');
const { hashToken } = require('../utils/security');

function createAuthMiddleware(authService, env) {
  const cookieName = env.SESSION_COOKIE_NAME;

  async function attachUser(req, res, next) {
    try {
      const rawToken = req.cookies?.[cookieName];
      const session = await authService.getSession(rawToken);
      if (session) {
        req.session = session;
        req.user = session.user;
      }
      next();
    } catch (error) {
      next(error);
    }
  }

  function requireAuth(req, res, next) {
    if (!req.user) {
      next(new AppError('Autenticacao obrigatoria.', 401, 'AUTH_REQUIRED'));
      return;
    }
    next();
  }

  function requireCsrf(req, res, next) {
    if (!req.user || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      next();
      return;
    }

    const csrfToken = req.headers['x-csrf-token'];
    if (!csrfToken || hashToken(csrfToken) !== req.session.csrf_token_hash) {
      next(new AppError('Token CSRF invalido.', 403, 'INVALID_CSRF_TOKEN'));
      return;
    }
    next();
  }

  return {
    attachUser,
    requireAuth,
    requireCsrf,
  };
}

module.exports = { createAuthMiddleware };
