"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MessageCircle,
  Mic,
  MicOff,
  Square,
  Loader2,
  FileText,
  Mail,
  User,
  CheckCircle2,
} from "lucide-react";
import Vapi from "@vapi-ai/web";
import {
  DEFAULT_SIMLI_API_KEY,
  DEFAULT_VAPI_PUBLIC_KEY,
} from "@/config/vapi-simli-ids";
import { apiRequest } from "@/lib/queryClient";

declare global {
  interface Window {
    Vapi: any;
    SimliClient: any;
    BroadcastChannel?: {
      new (name: string): {
        postMessage(message: any): void;
        close(): void;
        onmessage: ((event: MessageEvent) => void) | null;
      };
    };
  }
}

type AvatarState =
  | "idle"
  | "connecting"
  | "connected"
  | "listening"
  | "speaking"
  | "error";

export default function LandingAvatar() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const simliClientRef = useRef<any>(null);
  const vapiRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const isStoppingRef = useRef<boolean>(false);

  const [avatarState, setAvatarState] = useState<AvatarState>("idle");
  const [isVisible, setIsVisible] = useState(false);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string>("");
  const [isInitializing, setIsInitializing] = useState(false);
  const [isPreInitialized, setIsPreInitialized] = useState(false);
  const [isMicDenied, setIsMicDenied] = useState(false);

  const [signingLink, setSigningLink] = useState<string | null>(null);
  const [isCreatingSigningLink, setIsCreatingSigningLink] = useState(false);
  const [signingLinkError, setSigningLinkError] = useState<string | null>(null);
  const [contractSignedSuccess, setContractSignedSuccess] = useState(false);

  const [showContractDialog, setShowContractDialog] = useState(false);
  const [contractEmail, setContractEmail] = useState("");
  const [contractName, setContractName] = useState("");
  const [pendingFunctionCallId, setPendingFunctionCallId] = useState<
    string | null
  >(null);
  const [hasProcessedContractRequest, setHasProcessedContractRequest] =
    useState(false);

  const hasProcessedContractRequestRef = useRef(false);
  const signingLinkRef = useRef<string | null>(null);
  const SIMLI_FACE_ID =
    process.env.NEXT_PUBLIC_SIMLI_FACE_ID ||
    "afdb6a3e-3939-40aa-92df-01604c23101c";
  const VAPI_ASSISTANT_ID =
    process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ||
    "78166dbf-3946-4252-9262-39bfd87150f2";
  const VAPI_API_KEY =
    process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ||
    process.env.NEXT_PUBLIC_VAPI_AI_API_KEY ||
    DEFAULT_VAPI_PUBLIC_KEY;
  const SIMLI_API_KEY =
    process.env.NEXT_PUBLIC_SIMLI_API_KEY || DEFAULT_SIMLI_API_KEY;

  useEffect(() => {
    if (!VAPI_API_KEY) {
      setError("Vapi API key not configured");
    }
  }, [VAPI_API_KEY]);

  const initializeAudioContext = useCallback(async () => {
    try {
      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        return audioContextRef.current;
      }

      const AudioContextClass =
        window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass({
        sampleRate: 16000,
        latencyHint: "playback",
      });

      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }

      audioContextRef.current = audioContext;
      return audioContext;
    } catch (error) {
      console.error("Failed to initialize audio context:", error);
      return null;
    }
  }, []);

  const setupAudioPipeline = useCallback(
    async (audioElement: HTMLAudioElement, simliClient: any) => {
      try {
        if (audioProcessorRef.current) {
          audioProcessorRef.current.disconnect();
          audioProcessorRef.current = null;
        }

        if (audioContextRef.current) {
          await audioContextRef.current.close();
          audioContextRef.current = null;
        }

        const audioContext = await initializeAudioContext();
        if (!audioContext) {
          throw new Error("Failed to initialize audio context");
        }

        const source = audioContext.createMediaStreamSource(
          audioElement.srcObject as MediaStream
        );

        const processor = audioContext.createScriptProcessor(512, 1, 1);
        audioProcessorRef.current = processor;

        const audioBuffer: { data: Int16Array; timestamp: number }[] = [];
        const SYNC_BUFFER_MS = 60;
        const audioChunkDuration = (512 / 16000) * 1000;

        processor.onaudioprocess = (e: AudioProcessingEvent) => {
          const inputData = e.inputBuffer.getChannelData(0);
          const currentTime = audioContext.currentTime;

          let sumSquares = 0;
          for (let i = 0; i < inputData.length; i++) {
            sumSquares += inputData[i] * inputData[i];
          }

          const rms = Math.sqrt(sumSquares / inputData.length);
          const AUDIO_THRESHOLD = 0.01;
          
          if (rms < AUDIO_THRESHOLD) {
            return;
          }

          const targetRMS = 0.25;
          const gain = rms > 0 ? Math.min(targetRMS / rms, 2.0) : 1.0;

          const pcm16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            const normalizedSample = Math.max(
              -1,
              Math.min(1, inputData[i] * gain)
            );
            pcm16[i] =
              normalizedSample < 0
                ? normalizedSample * 0x8000
                : normalizedSample * 0x7fff;
          }

          audioBuffer.push({ data: pcm16, timestamp: currentTime });

          while (audioBuffer.length > 0) {
            const bufferedItem = audioBuffer[0];
            const timeSinceCapture =
              (currentTime - bufferedItem.timestamp) * 1000;
            if (timeSinceCapture >= SYNC_BUFFER_MS) {
              const item = audioBuffer.shift();
              if (item && simliClient) {
                try {
                  simliClient.sendAudioData(item.data);
                } catch (error) {
                  // Ignore sendAudioData errors
                }
              }
            } else {
              break;
            }
          }
        };

        source.connect(processor);
        processor.connect(audioContext.destination);

        let lastSyncCheck = audioContext.currentTime;
        const driftCorrectionInterval = setInterval(() => {
          if (!audioContext || !simliClient || !videoRef.current) {
            clearInterval(driftCorrectionInterval);
            return;
          }

          const currentAudioTime = audioContext.currentTime;
          const elapsed = (currentAudioTime - lastSyncCheck) * 1000;

          if (elapsed >= 2000) {
            lastSyncCheck = currentAudioTime;
            if (
              videoRef.current &&
              typeof videoRef.current.playbackRate !== "undefined"
            ) {
              const bufferSize = audioBuffer.length;
              const targetBufferSize = Math.ceil(
                SYNC_BUFFER_MS / audioChunkDuration
              );
              const drift = bufferSize - targetBufferSize;

              if (Math.abs(drift) > 1) {
                if (drift > 2) {
                  videoRef.current.playbackRate = 0.98;
                } else if (drift < -2) {
                  videoRef.current.playbackRate = 1.02;
                } else {
                  if (videoRef.current.playbackRate !== 1.0) {
                    videoRef.current.playbackRate = 1.0;
                  }
                }
              }
            }
          }
        }, 100);

        (audioContext as any)._driftCorrectionInterval =
          driftCorrectionInterval;
      } catch (error) {
        console.error("Failed to set up audio pipeline:", error);
      }
    },
    [initializeAudioContext]
  );

  const checkMicrophonePermission = useCallback(
    async (setErrors: boolean = true): Promise<boolean> => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          if (setErrors) {
            setError("Microphone not supported in this browser.");
          }
          return false;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        stream.getTracks().forEach((track) => track.stop());
        return true;
      } catch (err: any) {
        console.error("Microphone access check failed:", err);
        if (!setErrors) {
          return false;
        }

        if (
          err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError"
        ) {
          setIsMicDenied(true);
          setError(
            "Microphone access denied. Please allow microphone access to continue."
          );
          return false;
        } else if (err.name === "NotFoundError") {
          setError("No microphone found. Please connect a microphone device.");
          return false;
        } else {
          setError(
            "Failed to access microphone. Please check your microphone settings."
          );
          return false;
        }
      }
    },
    []
  );

  const startAvatar = useCallback(async () => {
    if (!VAPI_API_KEY || !SIMLI_API_KEY) {
      setError("Missing API keys. Please check environment configuration.");
      return;
    }

    try {
      isStoppingRef.current = false;
      setIsInitializing(true);
      setError(null);
      setIsMicDenied(false);
      setAvatarState("connecting");
      setTranscript("");

      const hasMicAccess = await checkMicrophonePermission();
      if (!hasMicAccess) {
        setIsInitializing(false);
        setAvatarState("error");
        return;
      }

      if (!isPreInitialized) {
        const { SimliClient } = await import("simli-client");
        const simliClient = new SimliClient();

        await simliClient.Initialize({
          apiKey: SIMLI_API_KEY,
          faceID: SIMLI_FACE_ID,
          handleSilence: true,
          videoRef: videoRef.current,
          audioRef: audioRef.current!,
        } as any);

        simliClientRef.current = simliClient;

        const vapi = new Vapi(VAPI_API_KEY);
        vapiRef.current = vapi;
      }

      if (simliClientRef.current) {
        await simliClientRef.current.start();
      }

      // Set up Vapi event handlers
      vapiRef.current.on("call-start", async () => {
        setAvatarState("connected");

        if (audioRef.current) {
          audioRef.current.muted = false;
          audioRef.current.volume = 1.0;
          audioRef.current.play().catch(() => {});
        }

        setTimeout(async () => {
          try {
            let dailyCall =
              (vapiRef.current as any)?.dailyCall ||
              (vapiRef.current as any)?._dailyCall ||
              (vapiRef.current as any)?.call;

            if (!dailyCall) {
              await new Promise((resolve) => setTimeout(resolve, 200));
              dailyCall =
                (vapiRef.current as any)?.dailyCall ||
                (vapiRef.current as any)?._dailyCall ||
                (vapiRef.current as any)?.call;
            }

            if (dailyCall && typeof dailyCall.participants === "function") {
              const participants = dailyCall.participants();

              for (const [id, participant] of Object.entries(
                participants as any
              )) {
                if (id !== "local") {
                  const tracks = (participant as any).tracks;
                  const audioTrack =
                    tracks?.audio?.persistentTrack ||
                    tracks?.audio?.track ||
                    (participant as any).audioTrack;

                  if (audioTrack) {
                    const mediaStream = new MediaStream([audioTrack]);
                    audioRef.current!.srcObject = mediaStream;
                    audioRef.current!.muted = false;

                    Promise.all([
                      audioRef.current!.play(),
                      new Promise((resolve) => {
                        if (videoRef.current)
                          videoRef.current.playbackRate = 1.0;
                        resolve(true);
                      }),
                    ]);

                    await setupAudioPipeline(
                      audioRef.current!,
                      simliClientRef.current!
                    );
                    return;
                  }
                }
              }
            }
          } catch (err) {
            // Fallback mode
          }
        }, 100);
      });

      vapiRef.current.on("call-end", () => {
        setAvatarState("idle");
      });

      vapiRef.current.on("speech-start", () => {
        setAvatarState("listening");
      });

      vapiRef.current.on("speech-end", () => {
        setAvatarState("connected");
      });

      vapiRef.current.on("model-output" as any, (data: any) => {
        if (data?.content?.trim()) {
          setTranscript(data.content);
          setAvatarState("speaking");
        }
      });

      vapiRef.current.on("message", (data: any) => {
        if (
          data?.toolCalls ||
          data?.tool_calls ||
          data?.type === "tool-calls"
        ) {
          const toolCalls = data.toolCalls || data.tool_calls || [];
          if (toolCalls.length > 0) {
            const toolCall = toolCalls[0];
            const fnName = toolCall?.function?.name || toolCall?.name;
            const fnArgs = toolCall?.function?.arguments
              ? typeof toolCall.function.arguments === "string"
                ? JSON.parse(toolCall.function.arguments)
                : toolCall.function.arguments
              : toolCall?.parameters || {};
            const callId = toolCall?.id || toolCall?.callId;

            if (
              fnName === "get_contract_signing_link" ||
              fnName === "getContractSigningLink" ||
              fnName === "createSigningLink"
            ) {
              const email = fnArgs.email || fnArgs.userEmail;
              const name = fnArgs.name || fnArgs.userName || fnArgs.fullName;

              if (!email) {
                if ((window as any).__contractDialogTimeout) {
                  clearTimeout((window as any).__contractDialogTimeout);
                  delete (window as any).__contractDialogTimeout;
                }

                setHasProcessedContractRequest(true);
                setPendingFunctionCallId(callId);
                setContractEmail("");
                setContractName("");
                setShowContractDialog(true);

                const collectingMsg =
                  "I've opened a form for the user to enter their email and name. Once they fill it out and submit, I'll create the contract signing link immediately.";

                if (
                  vapiRef.current &&
                  typeof (vapiRef.current as any).send === "function"
                ) {
                  (vapiRef.current as any).send({
                    type: "function-call-result",
                    functionCallId: callId,
                    result: collectingMsg,
                  });
                }
              } else {
                setIsCreatingSigningLink(true);
                setSigningLinkError(null);

                apiRequest("POST", "/api/boldsign/create-signing-link", {
                  email,
                  name,
                })
                  .then((res) => res.json())
                  .then((data) => {
                    if (data.success && data.signingLink) {
                      setSigningLink(data.signingLink);
                      signingLinkRef.current = data.signingLink;
                      setHasProcessedContractRequest(true);
                      hasProcessedContractRequestRef.current = true;

                      if ((window as any).__contractDialogTimeout) {
                        clearTimeout((window as any).__contractDialogTimeout);
                        delete (window as any).__contractDialogTimeout;
                      }

                      const allTimeouts =
                        (window as any).__allContractTimeouts || [];
                      allTimeouts.forEach((id: any) => clearTimeout(id));
                      (window as any).__allContractTimeouts = [];

                      setShowContractDialog(false);
                      setContractEmail("");
                      setContractName("");
                    } else {
                      throw new Error(
                        data.error || "Failed to create signing link"
                      );
                    }
                  })
                  .catch((err) => {
                    setSigningLinkError(
                      err?.message || "Failed to create signing link"
                    );
                  })
                  .finally(() => {
                    setIsCreatingSigningLink(false);
                  });
              }
            }
          }
        }

        if (data?.transcript?.trim()) {
          const speaker =
            data.role === "assistant" || data.role === "bot"
              ? "avatar"
              : "user";

          if (speaker === "avatar") {
            setTranscript(data.transcript);
            setAvatarState("speaking");

            if (
              hasProcessedContractRequest ||
              hasProcessedContractRequestRef.current ||
              signingLinkRef.current
            ) {
              return;
            }

            const transcriptLower = data.transcript.toLowerCase();
            const contractKeywords = [
              "contract",
              "sign",
              "signing",
              "enrollment agreement",
              "sign the",
            ];

            const hasContractKeyword = contractKeywords.some((keyword) =>
              transcriptLower.includes(keyword)
            );

            const shouldTriggerFallback =
              hasContractKeyword &&
              !showContractDialog &&
              !signingLink &&
              !signingLinkRef.current &&
              !isCreatingSigningLink &&
              !hasProcessedContractRequest &&
              !hasProcessedContractRequestRef.current &&
              contractEmail === "" &&
              contractName === "" &&
              !pendingFunctionCallId;

            if (shouldTriggerFallback) {
              const timeoutId = setTimeout(() => {
                if (
                  !showContractDialog &&
                  !signingLink &&
                  !signingLinkRef.current &&
                  !isCreatingSigningLink &&
                  !hasProcessedContractRequest &&
                  !hasProcessedContractRequestRef.current &&
                  contractEmail === "" &&
                  contractName === "" &&
                  !pendingFunctionCallId
                ) {
                  setShowContractDialog(true);
                }
              }, 1500);

              (window as any).__contractDialogTimeout = timeoutId;

              if (!(window as any).__allContractTimeouts) {
                (window as any).__allContractTimeouts = [];
              }
              (window as any).__allContractTimeouts.push(timeoutId);
            }
          }
        }
      });

      vapiRef.current.on("error", async (error: any) => {
        if (isStoppingRef.current) {
          return;
        }

        const errorMsg = error?.errorMsg || "";
        const errorName = error?.error?.name || "";
        const errorMessage = error?.error?.message || "";

        const isMicDeniedError =
          errorMsg.toLowerCase().includes("microphone") ||
          errorMsg.toLowerCase().includes("permission") ||
          errorName === "NotAllowedError" ||
          errorName === "PermissionDeniedError" ||
          errorMessage.toLowerCase().includes("microphone");

        if (isMicDeniedError) {
          setIsMicDenied(true);
          setError(null);
          setAvatarState("error");
          return;
        }

        if (error.error && typeof error.error.text === "function") {
          try {
            const errorText = await error.error.text();
            const errorJson = JSON.parse(errorText);
            setError(
              `Vapi Error: ${errorJson.message || errorJson.error || "Assistant not found or invalid configuration"}`
            );
          } catch (e) {
            setError(
              "Vapi connection error - please check assistant configuration"
            );
          }
        } else {
          setError(error?.errorMsg || "Vapi connection error");
        }

        setAvatarState("error");
      });

      vapiRef.current.on("function-call" as any, async (functionCall: any) => {
        const fnName = functionCall?.functionCall?.name || functionCall?.name;
        let fnArgs =
          functionCall?.functionCall?.parameters ||
          functionCall?.parameters ||
          {};

        if (typeof fnArgs === "string") {
          try {
            fnArgs = JSON.parse(fnArgs);
          } catch (e) {
            // Ignore parse errors
          }
        }

        const callId =
          functionCall?.functionCall?.id ||
          functionCall?.call?.id ||
          functionCall?.id;

        try {
          if (
            fnName === "get_contract_signing_link" ||
            fnName === "getContractSigningLink" ||
            fnName === "createSigningLink"
          ) {
            const email = fnArgs.email || fnArgs.userEmail;
            const name = fnArgs.name || fnArgs.userName || fnArgs.fullName;

            if (email) {
              setIsCreatingSigningLink(true);
              setSigningLinkError(null);

              try {
                const response = await apiRequest(
                  "POST",
                  "/api/boldsign/create-signing-link",
                  {
                    email,
                    name,
                  }
                );

                const data = await response.json();

                if (data.success && data.signingLink) {
                  setSigningLink(data.signingLink);
                  signingLinkRef.current = data.signingLink;
                  setHasProcessedContractRequest(true);
                  hasProcessedContractRequestRef.current = true;

                  if ((window as any).__contractDialogTimeout) {
                    clearTimeout((window as any).__contractDialogTimeout);
                    delete (window as any).__contractDialogTimeout;
                  }

                  const allTimeouts = (window as any).__allContractTimeouts || [];
                  allTimeouts.forEach((id: any) => clearTimeout(id));
                  (window as any).__allContractTimeouts = [];

                  setShowContractDialog(false);
                  setContractEmail("");
                  setContractName("");

                  const successMsg = `Perfect! I've created your contract signing link. You can see it below and click to sign the enrollment contract.`;

                  if (
                    vapiRef.current &&
                    typeof (vapiRef.current as any).send === "function"
                  ) {
                    (vapiRef.current as any).send({
                      type: "function-call-result",
                      functionCallId: callId,
                      result: successMsg,
                    });
                  }

                  return { result: successMsg };
                } else {
                  throw new Error(data.error || "Failed to create signing link");
                }
              } catch (apiError: any) {
                const errorMsg =
                  "I'm sorry, I encountered an issue creating your signing link. Please try again or contact support.";
                setSigningLinkError(
                  apiError?.message || "Failed to create signing link"
                );

                if (
                  vapiRef.current &&
                  typeof (vapiRef.current as any).send === "function"
                ) {
                  (vapiRef.current as any).send({
                    type: "function-call-result",
                    functionCallId: callId,
                    result: errorMsg,
                  });
                }

                return { result: errorMsg };
              } finally {
                setIsCreatingSigningLink(false);
              }
            } else {
              if ((window as any).__contractDialogTimeout) {
                clearTimeout((window as any).__contractDialogTimeout);
                delete (window as any).__contractDialogTimeout;
              }

              setHasProcessedContractRequest(true);
              setPendingFunctionCallId(callId);
              setContractEmail("");
              setContractName("");
              setShowContractDialog(true);

              const dialogMsg =
                "I've opened a form for you to enter your email and name. Once you fill it out and submit, I'll create your contract signing link immediately.";

              if (
                vapiRef.current &&
                typeof (vapiRef.current as any).send === "function"
              ) {
                (vapiRef.current as any).send({
                  type: "function-call-result",
                  functionCallId: callId,
                  result: dialogMsg,
                });
              }

              return { result: dialogMsg };
            }
          }
        } catch (fnError) {
          console.error("[LandingAvatar] Error handling function call:", fnError);
        }
      });

      try {
        await vapiRef.current.start(VAPI_ASSISTANT_ID);
      } catch (startError) {

        const inlineConfig = {
          name: "Orb Chip Assistant",
          model: {
            provider: "openai" as const,
            model: "gpt-4o" as const,
            messages: [
              {
                role: "system" as const,
                content: `You are Orb Chip's virtual assistant helping potential customers learn about Orb Chip™ - circular silicon modules designed to run AI models directly in hardware. Be informative, technical, and enthusiastic about the product.

Key topics to cover:
- Orb Chip™ are circular silicon modules that run AI models in hardware
- Up to 100× faster performance and 90% lower power consumption
- Native execution - your model becomes the hardware
- Deterministic latency
- Compact & modular form factor
- Energy efficient
- Connectivity via USB, Wi-Fi, or Bluetooth
- Interaction - chips can work alone or join a unified network
- Technical specifications
- Pricing: $1,000 per chip, minimum order 50 units

CONTRACT SIGNING:
When users ask about signing contracts, enrollment agreements, or contract documents, use the get_contract_signing_link function.

When calling get_contract_signing_link:
1. If the user hasn't provided their email, call the function without email/name parameters - this will automatically open a form dialog
2. When the function returns saying "I've opened a form for you to enter your email and name", acknowledge: "I've opened a form for you to enter your details. Please fill in your email and name, then click 'Create Signing Link'."
3. Wait for the user to submit the form. Once the function returns with success, acknowledge: "Perfect! I've created your contract signing link. You can see the signing link displayed below the avatar. Click to open the signing interface and complete your enrollment."

Keep responses conversational, technical, and focused on helping users understand Orb Chip™ technology.`,
              },
            ],
          },
          voice: {
            provider: "vapi" as const,
            voiceId: "Kylie" as const,
          },
          transcriber: {
            provider: "deepgram" as const,
            model: "nova-2" as const,
            language: "en" as const,
            endpointing: 300,
          },
          tools: [
            {
              type: "function" as const,
              function: {
                name: "get_contract_signing_link",
                description:
                  "Get a signing link for the Orb Chip enrollment contract. This function creates a document from a template and returns an embedded signing link.",
                parameters: {
                  type: "object",
                  properties: {
                    email: {
                      type: "string",
                      description: "The user's email address. Required to create the signing link.",
                    },
                    name: {
                      type: "string",
                      description: "The user's full name. Optional - if not provided, the email prefix will be used.",
                    },
                  },
                  required: ["email"],
                },
              },
            },
          ],
          firstMessage:
            "Hi! I'm here to help you learn about Orb Chip™ - native silicon for AI models. What would you like to know?",
          endCallMessage:
            "Thanks for chatting! Ready to experience native silicon AI? Join our waitlist!",
        };

        await vapiRef.current.start(inlineConfig as any);
      }
    } catch (error: any) {
      console.error("Failed to start avatar:", error);
      setError(error?.message || "Failed to start avatar session");
      setAvatarState("error");
    } finally {
      setIsInitializing(false);
    }
  }, [
    VAPI_API_KEY,
    SIMLI_API_KEY,
    SIMLI_FACE_ID,
    VAPI_ASSISTANT_ID,
    setupAudioPipeline,
    isPreInitialized,
    checkMicrophonePermission,
  ]);

  const stopAvatar = useCallback(async () => {
    try {
      isStoppingRef.current = true;
      setError(null);
      setIsInitializing(false);

      if (vapiRef.current) {
        try {
          await vapiRef.current.stop();
        } catch (stopError) {
          // Ignore stop errors
        }
      }

      if (simliClientRef.current) {
        try {
          if (typeof simliClientRef.current.stop === "function") {
            await simliClientRef.current.stop();
          } else if (typeof simliClientRef.current.close === "function") {
            await simliClientRef.current.close();
          }
        } catch (err) {
          // Ignore stop errors
        }
        simliClientRef.current = null;
      }

      if (audioProcessorRef.current) {
        audioProcessorRef.current.disconnect();
        audioProcessorRef.current = null;
      }

      if (audioContextRef.current) {
        await audioContextRef.current.close();
        audioContextRef.current = null;
      }

      if (videoRef.current) {
        if (videoRef.current.srcObject) {
          const stream = videoRef.current.srcObject as MediaStream;
          stream.getTracks().forEach((track) => track.stop());
        }
        videoRef.current.srcObject = null;
        videoRef.current.pause();
        videoRef.current.load();
        videoRef.current.style.display = "none";
      }

      if (audioRef.current) {
        if (audioRef.current.srcObject) {
          const stream = audioRef.current.srcObject as MediaStream;
          stream.getTracks().forEach((track) => track.stop());
        }
        audioRef.current.srcObject = null;
        audioRef.current.pause();
      }

      setAvatarState("idle");
      setTranscript("");
      setError(null);
      setSigningLink(null);
      signingLinkRef.current = null;
      setSigningLinkError(null);
      setHasProcessedContractRequest(false);
      hasProcessedContractRequestRef.current = false;
      setIsCreatingSigningLink(false);
      setShowContractDialog(false);
      setContractEmail("");
      setContractName("");
      setPendingFunctionCallId(null);
      isStoppingRef.current = false;
    } catch (stopError) {
      console.error("Error stopping avatar:", stopError);
      setAvatarState("idle");
      setError(null);
      isStoppingRef.current = false;
    }
  }, []);

  const toggleMute = useCallback(() => {
    setMuted(!muted);
    if (vapiRef.current) {
      vapiRef.current.setMuted(!muted);
    }
  }, [muted]);

  const handleContractSubmit = useCallback(async () => {
    const email = contractEmail.trim();
    const name = contractName.trim();
    const callId = pendingFunctionCallId;

    if (!email) {
      setSigningLinkError("Please enter a valid email address");
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setSigningLinkError("Please enter a valid email address");
      return;
    }

    if (!name) {
      setSigningLinkError("Please enter your full name");
      return;
    }

    setHasProcessedContractRequest(true);
    hasProcessedContractRequestRef.current = true;
    setShowContractDialog(false);
    setIsCreatingSigningLink(true);
    setSigningLinkError(null);

    if ((window as any).__contractDialogTimeout) {
      clearTimeout((window as any).__contractDialogTimeout);
      delete (window as any).__contractDialogTimeout;
    }

    const allTimeouts = (window as any).__allContractTimeouts || [];
    allTimeouts.forEach((id: any) => clearTimeout(id));
    (window as any).__allContractTimeouts = [];

    try {
      const response = await apiRequest(
        "POST",
        "/api/boldsign/create-signing-link",
        {
          email: email,
          name: name,
        }
      );

      if (!response.ok) {
        let errorMessage = "Failed to create signing link";
        try {
          const errorData = await response.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch (e) {
          errorMessage = `Server error: ${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();

      if (data.success && data.signingLink) {
        const signingLinkUrl = data.signingLink;
        setSigningLink(signingLinkUrl);
        signingLinkRef.current = signingLinkUrl;
        setHasProcessedContractRequest(true);
        hasProcessedContractRequestRef.current = true;

        if ((window as any).__contractDialogTimeout) {
          clearTimeout((window as any).__contractDialogTimeout);
          delete (window as any).__contractDialogTimeout;
        }

        const allTimeouts = (window as any).__allContractTimeouts || [];
        allTimeouts.forEach((id: any) => clearTimeout(id));
        (window as any).__allContractTimeouts = [];

        setShowContractDialog(false);
        setContractEmail("");
        setContractName("");

        window.open(signingLinkUrl, "_blank", "noopener,noreferrer");

        const successMsg = `The user has successfully provided their email (${email}) and name (${name}) through the form. I've created the contract signing link and automatically opened it in a new tab for them. The user can now complete the signing process in that new tab.`;

        if (callId && vapiRef.current) {
          if (typeof (vapiRef.current as any).send === "function") {
            try {
              (vapiRef.current as any).send({
                type: "function-call-result",
                functionCallId: callId,
                result: successMsg,
              });
            } catch (sendError) {
              // Ignore send errors
            }
          }
        }

        setPendingFunctionCallId(null);
      } else {
        const errorMessage = data.error || data.message || "Failed to create signing link";
        throw new Error(errorMessage);
      }
    } catch (apiError: any) {
      let errorMsg = "Failed to create signing link";
      if (apiError instanceof Error) {
        errorMsg = apiError.message;
      } else if (typeof apiError === "string") {
        errorMsg = apiError;
      } else if (apiError?.error) {
        errorMsg = typeof apiError.error === "string" ? apiError.error : apiError.error.message || errorMsg;
      } else if (apiError?.message) {
        errorMsg = apiError.message;
      } else if (apiError?.response?.data?.error) {
        errorMsg = apiError.response.data.error;
      }
      
      setSigningLinkError(errorMsg);

      if (
        callId &&
        vapiRef.current &&
        typeof (vapiRef.current as any).send === "function"
      ) {
        (vapiRef.current as any).send({
          type: "function-call-result",
          functionCallId: callId,
          result:
            "I'm sorry, I encountered an issue creating your signing link. Please try again or contact support.",
        });
      }
    } finally {
      setIsCreatingSigningLink(false);
      setPendingFunctionCallId(null);
    }
  }, [contractEmail, contractName, pendingFunctionCallId]);

  const preInitializeServices = useCallback(async () => {
    if (isPreInitialized || !VAPI_API_KEY || !SIMLI_API_KEY) return;

    try {
      await initializeAudioContext();

      const { SimliClient } = await import("simli-client");
      const simliClient = new SimliClient();

      await simliClient.Initialize({
        apiKey: SIMLI_API_KEY,
        faceID: SIMLI_FACE_ID,
        handleSilence: false,
        videoRef: videoRef.current,
        audioRef: audioRef.current!,
      } as any);

      simliClientRef.current = simliClient;

      const vapi = new Vapi(VAPI_API_KEY);
      vapiRef.current = vapi;

      setIsPreInitialized(true);
    } catch (error) {
      // Will initialize on demand
    }
  }, [
    VAPI_API_KEY,
    SIMLI_API_KEY,
    SIMLI_FACE_ID,
    initializeAudioContext,
    isPreInitialized,
  ]);

  useEffect(() => {
    setIsVisible(true);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      preInitializeServices();
    }, 100);
    return () => clearTimeout(timer);
  }, [preInitializeServices]);

  useEffect(() => {
    const BroadcastChannelAPI =
      (window as any).BroadcastChannel || (globalThis as any).BroadcastChannel;

    if (!BroadcastChannelAPI) {
      return;
    }

    const channelName = "contract-signing-channel";
    const channel = new BroadcastChannelAPI(channelName);

    channel.onmessage = (event: MessageEvent) => {
      if (
        event.data &&
        event.data.type === "CONTRACT_SIGNED" &&
        event.data.success
      ) {
        setSigningLink(null);
        signingLinkRef.current = null;
        setSigningLinkError(null);
        setContractSignedSuccess(true);

        setTimeout(() => {
          setContractSignedSuccess(false);
        }, 5000);
      }
    };

    return () => {
      channel.close();
    };
  }, []);

  useEffect(() => {
    const BroadcastChannelAPI =
      (window as any).BroadcastChannel || (globalThis as any).BroadcastChannel;

    if (!BroadcastChannelAPI) {
      return;
    }

    if (window.opener && window.location.pathname === "/") {
      const referrer = document.referrer;
      const isFromBoldsign =
        referrer &&
        (referrer.includes("boldsign.com") || referrer.includes("boldsign.io"));

      if (isFromBoldsign) {
        const channelName = "contract-signing-channel";
        const channel = new BroadcastChannelAPI(channelName);

        channel.postMessage({
          type: "CONTRACT_SIGNED",
          success: true,
          timestamp: new Date().toISOString(),
        });

        channel.close();

        setTimeout(() => {
          try {
            window.close();
          } catch (error) {
            // Ignore close errors
          }
        }, 1000);
      }
    }
  }, []);

  return (
    <div className="flex justify-center items-center min-h-screen p-4 gradient-bg">
      <Card className="relative glass rounded-2xl p-6 lg:p-8 max-w-md w-full overflow-hidden animate-fade-in animate-glow">
        {/* Avatar Video */}
        <div
          className={`relative mb-4 lg:mb-6 ${isMicDenied ? "filter blur-md" : ""}`}
        >
          {(avatarState === "idle" || avatarState === "connecting") && (
            <div className="w-full h-64 lg:h-72 bg-gradient-to-br from-gray-800 via-gray-900 to-gray-800 rounded-xl relative overflow-hidden border border-white/10 shadow-2xl">
              <div className="absolute inset-0 bg-gradient-to-br from-purple-500/20 via-blue-500/20 to-purple-500/20 rounded-xl animate-pulse-slow"></div>
              
              <img
                src="/avatar/hank.webp"
                alt="Avatar Preview"
                className="absolute inset-0 w-full h-full object-cover rounded-xl transition-opacity duration-500"
                style={{ zIndex: 2, display: "block" }}
                key={avatarState}
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  target.style.display = "none";
                }}
                onLoad={(e) => {
                  const target = e.target as HTMLImageElement;
                  const placeholder = target.nextElementSibling as HTMLElement;
                  if (placeholder) {
                    placeholder.style.display = "none";
                  }
                  target.style.display = "block";
                }}
              />
              <div 
                className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-800 via-gray-900 to-gray-800 rounded-xl"
                style={{ zIndex: 1 }}
              >
                <div className="text-gray-400 text-sm animate-pulse-slow">Avatar Preview</div>
              </div>
            </div>
          )}

          <video
            ref={videoRef}
            className={`w-full h-64 lg:h-72 bg-gradient-to-br from-gray-800 via-gray-900 to-gray-800 rounded-xl object-cover border border-white/10 shadow-2xl transition-all duration-500 ${
              avatarState === "idle" || avatarState === "connecting"
                ? "hidden"
                : "animate-fade-in"
            }`}
            style={{
              display: avatarState === "idle" || avatarState === "connecting" ? "none" : "block"
            }}
            autoPlay
            muted
            playsInline
          />

          {avatarState === "connecting" && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/30 rounded-xl">
              <div className="flex items-center gap-2 text-white bg-black/60 px-4 py-2 rounded-lg">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-sm font-medium">Connecting...</span>
              </div>
            </div>
          )}
        </div>

        {/* Microphone Permission Denied Overlay */}
        {isMicDenied && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm rounded-2xl z-10">
            <div className="text-center text-white px-4 max-w-sm">
              <MicOff className="h-12 w-12 mx-auto mb-4 text-red-400" />
              <p className="text-base lg:text-lg font-medium mb-3">
                Microphone Access Required
              </p>
              <div className="space-y-3 text-xs text-gray-300">
                <p>Please allow microphone access in your browser:</p>
                <div className="bg-gray-800/50 rounded-lg p-3 text-left">
                  <p className="font-semibold mb-2">Steps to enable:</p>
                  <ol className="list-decimal list-inside space-y-1">
                    <li>Look for the microphone icon in your browser&apos;s address bar</li>
                    <li>Click on it and select &quot;Allow&quot;</li>
                    <li>Refresh this page</li>
                  </ol>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Audio Element */}
        <audio ref={audioRef} autoPlay muted={muted} />

        {/* Controls */}
        <div className="flex items-center justify-center gap-3 mb-3 lg:mb-4">
          {avatarState === "idle" ? (
            <Button
              onClick={startAvatar}
              disabled={isInitializing || !!error}
              size="sm"
              className="bg-gradient-to-r from-purple-600 via-blue-600 to-purple-600 hover:from-purple-700 hover:via-blue-700 hover:to-purple-700 text-white text-sm font-semibold transition-all duration-300 shadow-lg hover:shadow-xl hover:shadow-purple-500/50 hover:scale-105"
            >
              {isInitializing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Starting...
                </>
              ) : (
                <>
                  <MessageCircle className="h-4 w-4 mr-2" />
                  Start Chat
                </>
              )}
            </Button>
          ) : avatarState === "error" && isMicDenied ? null : avatarState !==
            "error" ? (
            <>
              <Button
                onClick={toggleMute}
                variant="outline"
                size="sm"
                className="border-white/20 text-white hover:bg-white/10 transition-all duration-300 hover:scale-110 hover:border-white/40"
              >
                {muted ? (
                  <MicOff className="h-4 w-4" />
                ) : (
                  <Mic className="h-4 w-4" />
                )}
              </Button>
              <Button
                onClick={stopAvatar}
                variant="outline"
                size="sm"
                className="border-white/20 text-white hover:bg-white/10 transition-all duration-300 hover:scale-110 hover:border-white/40"
              >
                <Square className="h-4 w-4" />
              </Button>
            </>
          ) : null}
        </div>

        {/* Status */}
        <div className="text-center text-xs lg:text-sm text-gray-300 mb-3 lg:mb-4 transition-all duration-300">
          {avatarState === "idle" && "Ready to chat about Orb Chip™"}
          {avatarState === "connecting" && "Connecting to AI assistant..."}
          {avatarState === "connected" && "Connected - Ask me anything!"}
          {avatarState === "listening" && "Listening..."}
          {avatarState === "speaking" && "Speaking..."}
          {avatarState === "error" && isMicDenied && "Microphone access required"}
          {avatarState === "error" && !isMicDenied && "Connection error"}
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-3 mb-4 animate-fade-in">
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        {/* Transcript */}
        {transcript && (
          <div className="glass rounded-lg p-3 mb-3 animate-fade-in border border-white/20">
            <p className="text-white text-sm">{transcript}</p>
          </div>
        )}

        {/* Contract Signing Link */}
        {isCreatingSigningLink && (
          <div className="bg-blue-500/20 border border-blue-500/30 rounded-lg p-3 mb-3 animate-fade-in">
            <div className="flex items-center gap-2 text-blue-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              <p className="text-sm">Creating your signing link...</p>
            </div>
          </div>
        )}

        {signingLinkError && (
          <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-3 mb-3 animate-fade-in">
            <p className="text-red-300 text-sm">{signingLinkError}</p>
          </div>
        )}

        {/* Contract Signed Success Message */}
        {contractSignedSuccess && (
          <div className="bg-green-500/20 border border-green-500/30 rounded-lg p-4 mb-3 animate-fade-in">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-green-400 mt-0.5 flex-shrink-0 animate-pulse-slow" />
              <div className="flex-1">
                <p className="text-green-300 text-sm font-medium mb-1">
                  Contract Signed Successfully! 🎉
                </p>
                <p className="text-green-200 text-xs">
                  Thank you for signing the enrollment contract. Your contract has been processed successfully.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Helper Text */}
        {avatarState === "idle" && !error && (
          <div className="text-center text-xs text-gray-400 mt-3 lg:mt-4">
            <p className="px-2">
              Ask me about Orb Chip™, specifications, pricing, or how to order!
            </p>
          </div>
        )}
      </Card>

      {/* Contract Signing Dialog */}
      <Dialog open={showContractDialog} onOpenChange={setShowContractDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-blue-500" />
              Contract Signing
            </DialogTitle>
            <DialogDescription>
              Please provide your email address and full name to generate your contract signing link.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="contract-email" className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Email Address <span className="text-red-500">*</span>
              </Label>
              <Input
                id="contract-email"
                type="email"
                placeholder="your.email@example.com"
                value={contractEmail}
                onChange={(e) => {
                  setContractEmail(e.target.value);
                  setSigningLinkError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && contractEmail.trim()) {
                    handleContractSubmit();
                  }
                }}
                className="w-full"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="contract-name" className="flex items-center gap-2">
                <User className="h-4 w-4" />
                Full Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="contract-name"
                type="text"
                placeholder="John Doe"
                value={contractName}
                onChange={(e) => {
                  setContractName(e.target.value);
                  setSigningLinkError(null);
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    contractEmail.trim() &&
                    contractName.trim()
                  ) {
                    handleContractSubmit();
                  }
                }}
                className="w-full"
              />
            </div>
            {signingLinkError && (
              <div className="bg-red-500/20 border border-red-500/30 rounded-lg p-2">
                <p className="text-red-300 text-sm">{signingLinkError}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowContractDialog(false);
                setContractEmail("");
                setContractName("");
                setSigningLinkError(null);
                setPendingFunctionCallId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleContractSubmit}
              disabled={
                !contractEmail.trim() ||
                !contractName.trim() ||
                isCreatingSigningLink
              }
              className="bg-blue-600 hover:bg-blue-700"
            >
              {isCreatingSigningLink ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Signing Link"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

