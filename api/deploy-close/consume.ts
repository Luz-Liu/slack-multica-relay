import { serve, type VercelLikeRequest, type VercelLikeResponse } from "../../src/vercel.js";
import { consumeDeployClose } from "../../src/deploy-close.js";
export const config = { api: { bodyParser: false } };
export default async function handler(req: VercelLikeRequest, res: VercelLikeResponse): Promise<void> {
  await serve(req, res, consumeDeployClose);
}
