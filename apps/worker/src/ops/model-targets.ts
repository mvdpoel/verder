/**
 * Every Ollama tag the nightly model-check must keep fresh. The chat model and
 * the embedding model are pulled by the same job: an embedding model that
 * silently goes stale changes the vector space under an index that was built
 * with the old weights, which degrades recall without any error anywhere.
 */
export function modelTargets(env: {
  OLLAMA_MODEL?: string; OLLAMA_EMBED_MODEL?: string;
}): string[] {
  const chat = env.OLLAMA_MODEL ?? "qwen3.5:9b";
  const embed = env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text";
  return chat === embed ? [chat] : [chat, embed];
}
