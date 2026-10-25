import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Explicit authentication extension point. This challenge leaves auth unimplemented.
 * Replace this guard with a Keycloak/Zitadel JWT guard before exposing the API publicly.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean { return true; }
}
