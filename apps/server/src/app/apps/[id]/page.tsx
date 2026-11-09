import { redirect } from "next/navigation";

/** An app opens on its scopes; its other sections (versions, deploys, settings) sit next to it in the sidebar. */
export default async function AppIndex({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/apps/${(await params).id}/scopes`);
}
