import { badRequest } from "../utils/appError.js";

export const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);

  if (!result.success) {
    next(badRequest("Validation failed", result.error.flatten()));
    return;
  }

  req.body = result.data;
  next();
};

export const validateQuery = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.query);

  if (!result.success) {
    next(badRequest("Validation failed", result.error.flatten()));
    return;
  }

  // Handle read-only 'query' property in Express 5 by using defineProperty
  Object.defineProperty(req, "query", {
    value: result.data,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  next();
};

export const validateParams = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.params);

  if (!result.success) {
    next(badRequest("Validation failed", result.error.flatten()));
    return;
  }

  // Handle read-only 'params' property in Express 5 by using defineProperty
  Object.defineProperty(req, "params", {
    value: result.data,
    writable: true,
    configurable: true,
    enumerable: true,
  });

  next();
};
