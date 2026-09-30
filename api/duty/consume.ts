import { serve, type VercelLikeRequest, type VercelLikeResponse } from '../../src/vercel.js';
import { consumeDuty } from '../../src/duty-http.js';
export const config = { api: { bodyParser: false } };
export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> { await serve(req,res,consumeDuty); }
