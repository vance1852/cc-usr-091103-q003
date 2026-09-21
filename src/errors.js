export class DomainError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "DomainError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const invalidRequest = (message) => new DomainError(400, "invalid_request", message);
export const notFound = (message) => new DomainError(404, "not_found", message);
export const conflict = (message) => new DomainError(409, "conflict", message);
