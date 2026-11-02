/** Throw from a route handler to send `{ error: { code, message } }` with the given status. */
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string) => new HttpError(400, 'invalid_request', message);
