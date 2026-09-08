class AppError extends Error {
  constructor(message, statusCode = 400, code = 'APP_ERROR', details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

class MercadoPagoError extends AppError {
  constructor(message, statusCode = 502, code = 'MERCADOPAGO_ERROR', details = null) {
    super(message, statusCode, code, details);
    this.name = 'MercadoPagoError';
  }
}

module.exports = { AppError, MercadoPagoError };
