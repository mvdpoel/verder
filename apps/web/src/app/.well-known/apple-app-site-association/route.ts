/*
 * The apple-app-site-association file: the public fact that lets the iOS app
 * (`<team>.pro.vanderpoel.verder`) use passkeys bound to this hostname.
 *
 * Read per request, never at build time, so the team id comes from
 * `.env.prod` on the running container. With no team configured the route
 * answers 404: publishing `undefined.pro.vanderpoel.verder` would tell iOS a
 * wrong app owns the domain's credentials.
 */
export const dynamic = "force-dynamic";

const BUNDLE_ID = "pro.vanderpoel.verder";

export async function GET(): Promise<Response> {
  const team = process.env.APPLE_TEAM_ID?.trim();
  if (!team) return new Response("Not found", { status: 404 });
  return Response.json({ webcredentials: { apps: [`${team}.${BUNDLE_ID}`] } });
}
