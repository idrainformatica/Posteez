export const openAIBaseUrl = () => process.env.OPENAI_BASE_URL;

export const openAIModel = (fallback: string) =>
  process.env.OPENAI_MODEL || fallback;
