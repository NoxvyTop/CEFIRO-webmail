export class DomainError extends Error {
    code;
    httpStatus;
    messageKey;
    constructor(code, httpStatus, messageKey) {
        super(messageKey);
        this.code = code;
        this.httpStatus = httpStatus;
        this.messageKey = messageKey;
        this.name = "DomainError";
    }
}
