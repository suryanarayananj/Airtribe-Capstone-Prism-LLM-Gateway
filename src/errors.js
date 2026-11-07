/**
 * Gateway error mapped to OpenAI-style envelope + HTTP status.
 */
export class PrismError extends Error {
  /**
   * @param {object} opts
   * @param {number} opts.statusCode
   * @param {string} opts.type
   * @param {string} opts.message
   * @param {string | null} [opts.code]
   */
  constructor({ statusCode, type, message, code = null }) {
    super(message);
    this.name = 'PrismError';
    this.statusCode = statusCode;
    this.type = type;
    this.code = code ?? type;
  }

  toResponseBody() {
    return {
      error: {
        message: this.message,
        type: this.type,
        code: this.code,
      },
    };
  }
}

/**
 * Fastify error handler: PrismError → contract body; others → 500.
 * @param {import('fastify').FastifyError | Error} error
 * @param {import('fastify').FastifyRequest} _request
 * @param {import('fastify').FastifyReply} reply
 */
export function prismErrorHandler(error, _request, reply) {
  if (error instanceof PrismError) {
    return reply.status(error.statusCode).send(error.toResponseBody());
  }

  const statusCode = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  reply.status(statusCode).send({
    error: {
      message: statusCode === 500 ? 'Internal server error' : error.message,
      type: statusCode === 500 ? 'server_error' : 'invalid_request_error',
      code: null,
    },
  });
}
