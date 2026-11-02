// A scripted stand-in for a real model behind the fake OpenAI-compatible server.
// It answers the JARVIS understanding and decision prompts exactly like the fixture
// adapters would, so tests can drive vLLM-mode plumbing (startup probes, benchmark
// runner) end to end. It measures plumbing only: it is NOT a real model.
import { FixtureModelAdapter, type ModelInput } from "../src/model-adapter.ts";
import { FixtureRequestUnderstandingAdapter, UNDERSTANDING_SYSTEM_PROMPT } from "../src/request-understanding.ts";

interface ChatBody {
  messages: { role: string; content: string }[];
}

export async function fixtureLikeAnswer(body: unknown): Promise<string> {
  const [system, user] = (body as ChatBody).messages;
  const payload = JSON.parse(user!.content) as Record<string, unknown>;
  const signal = new AbortController().signal;
  if (system!.content === UNDERSTANDING_SYSTEM_PROMPT) {
    const customerMessage = payload.untrusted_customer_message as string;
    return new FixtureRequestUnderstandingAdapter().understand({ untrusted: { customerMessage } }, signal);
  }
  const input = { evidence: payload.authoritative_evidence } as ModelInput;
  return new FixtureModelAdapter().propose(input, signal);
}
