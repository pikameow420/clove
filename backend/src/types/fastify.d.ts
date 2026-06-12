import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      externalId: string;
    };
    _authUser?: {
      id: string;
      externalId: string;
    };
  }
}
