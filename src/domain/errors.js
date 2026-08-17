export class AppError extends Error {
  constructor(message, { code = "APP_ERROR", status = 400, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class NotFoundError extends AppError {
  constructor(resource, id) {
    super(`${resource} '${id}' was not found`, { code: "NOT_FOUND", status: 404 });
  }
}

export class ConflictError extends AppError {
  constructor(message, code = "CONFLICT") {
    super(message, { code, status: 409 });
  }
}

export class PolicyError extends AppError {
  constructor(message, code = "POLICY_REJECTED", details) {
    super(message, { code, status: 422, details });
  }
}

export class LimitReachedError extends PolicyError {
  constructor(maximumAtomic, projectedAtomic) {
    super("The next operation would exceed the authorized maximum", "LIMIT_REACHED", {
      maximumAtomic: String(maximumAtomic),
      projectedAtomic: String(projectedAtomic),
    });
  }
}
