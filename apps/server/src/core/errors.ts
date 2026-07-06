export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    readonly messageKey: string,
  ) {
    super(messageKey);
    this.name = "DomainError";
  }
}
