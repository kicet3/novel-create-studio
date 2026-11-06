/**
 * Application errors. Modules throw these; the HTTP error handler maps them to status codes
 * and the standard error body `{ error: { code, message, details } }` (@ncs/shared/dto apiErrorSchema).
 * `message` is user-facing Korean copy.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** object particle 을/를 by the last Hangul syllable's final consonant (을(를) when the word does not end in Hangul) */
export function objectParticle(word: string): string {
  const c = word.trim().codePointAt(word.trim().length - 1) ?? 0;
  if (c < 0xac00 || c > 0xd7a3) return "을(를)";
  return (c - 0xac00) % 28 === 0 ? "를" : "을";
}

/** 404 — also used for cross-tenant access (03 T-4: never 403 for another novel's id). */
export class NotFoundError extends AppError {
  constructor(what: string, id?: string) {
    super(404, "not_found", `${what}${objectParticle(what)} 찾을 수 없습니다.`, id ? { id } : undefined);
  }
}

/** 409 — invariant / concurrent-update conflict. */
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

/** 409 — state machine transition not in the table (03 §4 "표에 없는 전이는 거부"). */
export class InvalidTransitionError extends AppError {
  constructor(aggregate: string, from: string, to: string, reason?: string) {
    super(409, "invalid_transition", reason ?? `${aggregate} 상태를 '${from}'에서 '${to}'(으)로 바꿀 수 없습니다.`, {
      aggregate,
      from,
      to,
    });
  }
}

/** 422 — semantically invalid input (zod-valid but violates a domain rule). */
export class DomainValidationError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(422, code, message, details);
  }
}

/** 501 — contract exists, implementation pending (placeholder modules). */
export class NotImplementedError extends AppError {
  constructor(what: string) {
    super(501, "not_implemented", `아직 구현되지 않은 기능입니다: ${what}`);
  }
}

/**
 * Build a service object whose every method throws NotImplementedError (placeholder modules only).
 * Registration methods (`register*`, `on<Upper>*`) are accepted as no-ops so implemented modules can
 * wire themselves into a still-placeholder module at boot without crashing.
 */
export function notImplementedService<T extends object>(moduleName: string): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      if (/^(register[A-Z]|on[A-Z])/.test(String(prop))) return () => undefined;
      return () => {
        throw new NotImplementedError(`${moduleName}.${String(prop)}`);
      };
    },
  });
}

/** Service with some methods implemented; the rest throw NotImplementedError (contracts-phase modules). */
export function partialService<T extends object>(moduleName: string, impl: Partial<T>): T {
  return Object.assign(Object.create(notImplementedService<T>(moduleName)) as T, impl);
}
