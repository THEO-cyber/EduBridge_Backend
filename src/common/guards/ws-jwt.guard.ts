import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

interface AuthenticatedSocket extends Socket {
  userId: string;
  user: any;
}

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const socket = context.switchToWs().getClient<AuthenticatedSocket>();

    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        throw new WsException('No token provided');
      }

      const payload = this.jwtService.verify(token);
      socket.userId = payload.sub;
      socket.user = payload;

      return true;
    } catch (error) {
      throw new WsException('Invalid token');
    }
  }
}
