import { AppError } from "../utils/appError.js";

const isProduction = process.env.NODE_ENV === "production";

const normalizeError = (err) => {
  if (err instanceof AppError) {
    return err;
  }

  if (err?.name === "SyntaxError" && "body" in err) {
    return new AppError("Invalid JSON request body", 400);
  }

  // Prisma known request errors
  if (err?.name === "PrismaClientKnownRequestError") {
    if (err.code === "P2002") {
      return new AppError("That email address is already registered.", 409);
    }
    if (err.code === "P2025") {
      return new AppError("The requested record was not found.", 404);
    }
    if (err.code === "P2003") {
      return new AppError("Related record not found.", 400);
    }
    // Catch-all for any other known Prisma error (e.g. enum validation)
    return new AppError("A database error occurred. Please try again.", 500);
  }

  // Prisma validation errors (schema mismatches, bad arguments)
  if (
    err?.name === "PrismaClientValidationError" ||
    err?.name === "PrismaClientInitializationError" ||
    err?.name === "PrismaClientRustPanicError"
  ) {
    return new AppError("A database error occurred. Please try again.", 500);
  }

  if (err?.name === "ZodError") {
    return new AppError("Validation failed", 400, {
      details: err.flatten?.(),
    });
  }

  return err;
};

export const notFoundHandler = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

export const globalErrorHandler = (err, req, res, next) => {
  const normalizedError = normalizeError(err);
  const statusCode = normalizedError.statusCode || 500;
  const status = normalizedError.status || "error";
  const message =
    normalizedError.isOperational || !isProduction
      ? normalizedError.message
      : "Internal server error";

  if (!normalizedError.isOperational || statusCode >= 500) {
    console.error(normalizedError);
  }

  const response = {
    status,
    message,
  };

  if (normalizedError.details && !isProduction) {
    response.details = normalizedError.details;
  }

  if (!isProduction && normalizedError.stack) {
    response.stack = normalizedError.stack;
  }

  res.status(statusCode).json(response);
};
