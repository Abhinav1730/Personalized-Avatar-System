export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface AvatarConversation {
  _id?: string;
  callId: string; // Vapi call ID
  startTime: Date;
  endTime: Date;
  duration: number; // Duration in seconds
  transcript: string; // Full transcript of the conversation
  messages?: ConversationMessage[]; // Optional: individual messages if needed
  metadata?: {
    assistantId?: string;
    vapiCallId?: string;
    errorCount?: number;
  };
  createdAt: Date;
}

