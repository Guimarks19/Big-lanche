const nodemailer = require('nodemailer');

class EmailService {
  constructor(env, transport = null) {
    this.env = env;
    this.transport = transport;
    this.outbox = [];
  }

  async sendVerificationEmail(user, token) {
    const url = `${this.env.APP_BASE_URL}/verificar-email?token=${encodeURIComponent(token)}`;
    return this.sendMail({
      to: user.email,
      subject: 'Confirme seu e-mail na Big Lanche',
      text: `Olá, ${user.name}. Confirme seu e-mail acessando: ${url}`,
      html: `<p>Olá, ${escapeHtml(user.name)}.</p><p>Confirme seu e-mail acessando <a href="${url}">este link</a>.</p>`,
      meta: { type: 'email_verification', url },
    });
  }

  async sendPasswordResetEmail(user, token) {
    const url = `${this.env.APP_BASE_URL}/redefinir-senha?token=${encodeURIComponent(token)}`;
    return this.sendMail({
      to: user.email,
      subject: 'Redefina sua senha na Big Lanche',
      text: `Para redefinir sua senha, acesse: ${url}`,
      html: `<p>Para redefinir sua senha, acesse <a href="${url}">este link</a>.</p>`,
      meta: { type: 'password_reset', url },
    });
  }

  async sendMail(message) {
    this.outbox.push(message);

    if (!this.transport && !this.env.SMTP_HOST) {
      if (this.env.NODE_ENV === 'production') {
        throw new Error('SMTP_HOST precisa estar configurado para envio real de e-mail.');
      }
      console.info('[EmailService] SMTP não configurado; e-mail mantido apenas em memória local.', {
        to: maskForLog(message.to),
        subject: message.subject,
        type: message.meta?.type,
      });
      return { sent: false };
    }

    const transport =
      this.transport ||
      nodemailer.createTransport({
        host: this.env.SMTP_HOST,
        port: this.env.SMTP_PORT,
        secure: this.env.SMTP_SECURE,
        auth: this.env.SMTP_USER
          ? {
              user: this.env.SMTP_USER,
              pass: this.env.SMTP_PASS,
            }
          : undefined,
      });

    await transport.sendMail({
      from: this.env.SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });

    return { sent: true };
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function maskForLog(email) {
  return String(email || '').replace(/^(.{2}).*(@.*)$/, '$1***$2');
}

module.exports = { EmailService };
