import { Token, Secret } from "fernet";

function getSecret(): Secret {
  const key = process.env.SPOTIFY_TOKEN_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      "SPOTIFY_TOKEN_ENCRYPTION_KEY environment variable is not set"
    );
  }
  return new Secret(key);
}

export function fernetEncrypt(plaintext: string): string {
  const secret = getSecret();
  const token = new Token({ secret });
  return token.encode(plaintext);
}

export function fernetDecrypt(ciphertext: string): string {
  const secret = getSecret();
  const token = new Token({
    secret,
    token: ciphertext,
    ttl: 0,
  });
  return token.decode();
}
