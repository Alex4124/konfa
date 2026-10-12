import { createSchedule, listSchedules } from "@/lib/schedule-server";
import { errorResponse, json, readJson } from "@/lib/confa-server";

export const runtime = "edge";

export async function GET(request: Request): Promise<Response> {
  try { return json({ schedules: await listSchedules(request) }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request): Promise<Response> {
  try { return json({ schedule: await createSchedule(request, await readJson(request)) }, 201); }
  catch (error) { return errorResponse(error); }
}
