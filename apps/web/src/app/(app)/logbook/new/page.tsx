import { EntryForm } from "@/components/entry-form";

export default async function NewEntryPage({ searchParams }: { searchParams: Promise<{ correct?: string }> }) {
  const { correct } = await searchParams;
  return <EntryForm correctId={correct} />;
}
