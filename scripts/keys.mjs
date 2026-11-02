import { randomBytes } from 'node:crypto';
console.log(`PHONE_TOKEN=${randomBytes(32).toString('base64url')}\nBRIDGE_TOKEN=${randomBytes(32).toString('base64url')}`);
