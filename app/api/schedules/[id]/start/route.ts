import { startSchedule } from "@/lib/schedule-server";
import { errorResponse, json } from "@/lib/confa-server";

export const runtime = "edge";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  try { return json(await startSchedule(request, (await context.params).id)); }
  catch (error) { return errorResponse(error); }
}
