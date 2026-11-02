export const PORT = Number(process.env.PORT) || 3000;
// Set HOST=127.0.0.1 behind a reverse proxy so the app is reachable only through it
export const HOST = process.env.HOST || undefined;
export const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/salim_pos';
