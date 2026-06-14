import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(configService: ConfigService) {
    // The callback must point to THIS BACKEND, not the frontend.
    const backendUrl = configService.get<string>('BACKEND_URL') ?? 'http://localhost:3000';
    super({
      clientID:     configService.get<string>('google.clientId')     ?? 'GOOGLE_CLIENT_ID',
      clientSecret: configService.get<string>('google.clientSecret') ?? 'GOOGLE_CLIENT_SECRET',
      callbackURL:  `${backendUrl}/api/v1/auth/google/callback`,
      scope: ['email', 'profile'],
      prompt: 'select_account', // always show account chooser — prevents auto-selecting cached account
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ) {
    const { id, name, emails, photos } = profile;
    done(null, {
      googleId:  id,
      email:     emails[0].value,
      firstName: name.givenName,
      lastName:  name.familyName,
      avatar:    photos?.[0]?.value,
    });
  }
}
