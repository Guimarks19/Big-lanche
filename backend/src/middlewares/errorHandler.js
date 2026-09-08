const { AppError } = require('../utils/errors');

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode < 500) {
    res.status(error.statusCode).json({
      error: {
        code: 'BAD_REQUEST',
        message: error.expose ? error.message : 'Requisicao invalida.',
      },
    });
    return;
  }

  console.error(error);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Erro interno no servidor.',
    },
  });
}

module.exports = { errorHandler };
