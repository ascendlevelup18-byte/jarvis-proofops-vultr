export type AssistantIntent = 'orders' | 'review' | 'attention' | 'unsupported';

/** Local guided routing only. User text is never sent as a refund request. */
export function assistantIntent(text: string): AssistantIntent {
  const s = text.toLowerCase();
  // Refuse unsupported writes before interpreting words such as "order".
  if (/\b(delete|cancel|ship|address|inventory|discount|email|send|approve|reject|transfer|buy)\b/.test(s)) return 'unsupported';
  if (/\b(refund|charged|charge|complaint|customer|twice|double)\b/.test(s)) return 'review';
  if (/\b(attention|approval|review|pending|help)\b/.test(s)) return 'attention';
  if (/\b(order|orders|today|sales)\b/.test(s)) return 'orders';
  return 'unsupported';
}
