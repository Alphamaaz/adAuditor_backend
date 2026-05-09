export class AppError extends Error {
  constructor(message, statusCode = 500, options = {}) {
    super(message);

    this.name = "AppError";
    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith("4") ? "fail" : "error";
    this.isOperational = true;
    this.details = options.details;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const badRequest = (message = "Bad request", details) =>
  new AppError(message, 400, { details });

export const unauthorized = (message = "Unauthorized") =>
  new AppError(message, 401);

export const forbidden = (message = "Forbidden") => new AppError(message, 403);

export const notFound = (message = "Resource not found") =>
  new AppError(message, 404);

export const tooManyRequests = (message = "Too many requests", details) =>
  new AppError(message, 429, { details });

export const paymentRequired = (message = "Payment required", details) =>
  new AppError(message, 402, { details });

export const serviceUnavailable = (message = "Service unavailable", details) =>
  new AppError(message, 503, { details });
