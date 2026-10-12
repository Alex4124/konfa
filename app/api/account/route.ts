import { changePassword, getAccount, login, logout, register, requireSameOrigin } from "@/lib/account-server";
import { AppError, errorResponse, json, readJson } from "@/lib/confa-server";

export const runtime = "edge";

export async function GET(request: Request): Promise<Response> {
  try { return json({ account: await getAccount(request) }); }
  catch (error) { return errorResponse(error); }
}

export async function POST(request: Request): Promise<Response> {
  try {
    requireSameOrigin(request);
    const input = await readJson(request);
    let result: { account?: unknown; cookie: string };
    if (input.action === "register") result = await register(request, input);
    else if (input.action === "login") result = await login(request, input);
    else if (input.action === "logout") result = { cookie: await logout(request) };
    else if (input.action === "password") result = { account: await getAccount(request, true), cookie: await changePassword(request, input) };
    else throw new AppError("Неизвестное действие");
    const response = json({ account: result.account || null }, input.action === "register" ? 201 : 200);
    response.headers.set("Set-Cookie", result.cookie);
    return response;
  } catch (error) { return errorResponse(error); }
}
