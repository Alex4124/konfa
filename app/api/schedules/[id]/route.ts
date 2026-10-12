import { cancelSchedule, editSchedule, getPublicSchedule } from "@/lib/schedule-server";
import { errorResponse, json, readJson } from "@/lib/confa-server";

export const runtime = "edge";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  try { return json({ schedule: await getPublicSchedule(request, (await context.params).id) }); }
  catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  try { return json({ schedule: await editSchedule(request, (await context.params).id, await readJson(request)) }); }
  catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  try { return json({ schedule: await cancelSchedule(request, (await context.params).id) }); }
  catch (error) { return errorResponse(error); }
}
