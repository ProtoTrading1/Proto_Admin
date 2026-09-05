export class OperationTimeoutError extends Error {
  constructor(message, code = 'operation_timeout') {
    super(message);
    this.name = 'OperationTimeoutError';
    this.code = code;
  }
}

export function withTimeout(promise, timeoutMs, message, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new OperationTimeoutError(message, code)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
