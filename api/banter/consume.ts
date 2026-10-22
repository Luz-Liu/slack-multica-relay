import { serve, type VercelLikeRequest, type VercelLikeResponse } from '../../src/vercel.js';
import { consumeBanter } from '../../src/banter-http.js';
export const config = { api: { bodyParser: false } };
export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> { await serve(req,res,consumeBanter); }
