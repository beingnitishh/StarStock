import { errResponse, readJson, requireUser } from "@/lib/api";
import { consumeProductImageUploadToken } from "@/lib/product-image-upload-tokens";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const user = await requireUser();
    const { token } = await ctx.params;
    const body = await readJson(req);
    const result = await consumeProductImageUploadToken(token, user.id, body.imageUrl);
    return Response.json(
      { ok: true, message: result.message },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errResponse(error);
  }
}
