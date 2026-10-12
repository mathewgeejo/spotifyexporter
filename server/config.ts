import 'dotenv/config';
import { resolve } from 'node:path';

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8080),
  dataDir: resolve(process.env.DATA_DIR || './data'),
  appUrl: process.env.APP_URL || 'http://127.0.0.1:8080',
  secureCookies: process.env.SECURE_COOKIES === 'true',
  spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
  spotifyRedirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:8080/api/connections/spotify/callback',
  maxUploadBytes: 512 * 1024 * 1024,
  maxExpandedBytes: 2 * 1024 * 1024 * 1024,
};
