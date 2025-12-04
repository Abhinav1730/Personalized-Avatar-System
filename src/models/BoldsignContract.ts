export type ContractStatus = 'pending' | 'signed' | 'expired' | 'cancelled';

export interface BoldsignContract {
  _id?: string;
  email: string;
  name: string;
  documentId: string; // Boldsign document ID
  signingLink: string;
  status: ContractStatus;
  signedAt?: Date; // When contract was signed
  createdAt: Date;
  expiresAt?: Date;
  metadata?: {
    sessionId?: string; // Link to avatar session if applicable
    callId?: string; // Vapi call ID if applicable
    redirectUrl?: string;
    expiresIn?: number; // Expiration time in seconds
  };
}

