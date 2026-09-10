function createAuthController(authService, env) {
  const cookieName = env.SESSION_COOKIE_NAME;
  const csrfCookieName = env.CSRF_COOKIE_NAME;

  return {
    async register(req, res) {
      const result = await authService.register(req.body || {});
      res.status(201).json({
        user: result.user,
        masked_email: result.masked_email,
        message: 'Cadastro criado. Confirme seu e-mail para acessar.',
      });
    },

    async login(req, res) {
      const { user, session } = await authService.login(req.body || {}, req);
      setSessionCookie(res, cookieName, csrfCookieName, session, env);
      res.json({ user, csrf_token: session.csrf_token });
    },

    async me(req, res) {
      if (!req.user) {
        res.json({ authenticated: false });
        return;
      }
      res.json({
        authenticated: true,
        user: req.user,
        csrf_token: req.cookies?.[csrfCookieName] || null,
      });
    },

    async logout(req, res) {
      await authService.logout(req.session?.id);
      clearSessionCookie(res, cookieName, csrfCookieName, env);
      res.json({ ok: true });
    },

    async verifyEmail(req, res) {
      const user = await authService.verifyEmail(req.query.token || req.body?.token);
      res.json({ verified: true, user });
    },

    async resendVerification(req, res) {
      const result = req.user
        ? await authService.resendVerification(req.user.id)
        : await authService.resendVerificationForEmail(req.body?.email);
      res.json(result);
    },

    async forgotPassword(req, res) {
      await authService.requestPasswordReset(req.body?.email);
      res.json({
        received: true,
        message: 'Se o e-mail existir e estiver verificado, enviaremos as instruções.',
      });
    },

    async resetPassword(req, res) {
      const result = await authService.resetPassword(
        req.body?.token || req.query.token,
        req.body?.password,
        req.body?.password_confirmation,
      );
      res.json(result);
    },
  };
}

function setSessionCookie(res, cookieName, csrfCookieName, session, env) {
  res.cookie(cookieName, session.token, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
  res.cookie(csrfCookieName, session.csrf_token, {
    httpOnly: false,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res, cookieName, csrfCookieName, env) {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
  res.clearCookie(csrfCookieName, {
    httpOnly: false,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  });
}

module.exports = { clearSessionCookie, createAuthController, setSessionCookie };
