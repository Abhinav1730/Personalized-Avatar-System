import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/mongodb";
import { BoldsignContract } from "@/models/BoldsignContract";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, name, callId, sessionId } = body;

    if (!email) {
      return NextResponse.json(
        { success: false, error: "Email is required" },
        { status: 400 }
      );
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return NextResponse.json(
        { success: false, error: "Invalid email format" },
        { status: 400 }
      );
    }

    const BOLDSIGN_API_KEY = process.env.BOLDSIGN_API_KEY;
    const BOLDSIGN_TEMPLATE_ID = process.env.BOLDSIGN_TEMPLATE_ID;
    const BOLDSIGN_API_BASE_URL =
      process.env.BOLDSIGN_API_BASE_URL || "https://api.boldsign.com/v1";

    if (!BOLDSIGN_API_KEY) {
      return NextResponse.json(
        {
          success: false,
          error: "Boldsign API key not configured. Please set BOLDSIGN_API_KEY in your .env file.",
        },
        { status: 500 }
      );
    }

    if (!BOLDSIGN_TEMPLATE_ID) {
      return NextResponse.json(
        {
          success: false,
          error: "Boldsign template ID not configured. Please set BOLDSIGN_TEMPLATE_ID in your .env file.",
        },
        { status: 500 }
      );
    }

    let baseUrl = BOLDSIGN_API_BASE_URL.replace(/\/$/, "");
    if (!baseUrl.endsWith("/v1")) {
      baseUrl = `${baseUrl}/v1`;
    }

    const frontendUrl = process.env.NEXT_PUBLIC_FRONTEND_URL || process.env.FRONTEND_URL || "http://localhost:3000";
    const redirectUrl = `${frontendUrl}/`;

    const createDocumentUrl = `${baseUrl}/template/send?templateId=${BOLDSIGN_TEMPLATE_ID}`;

    const createDocResponse = await fetch(createDocumentUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "X-API-KEY": BOLDSIGN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Orb Chip Enrollment Contract",
        message: "Please review and sign the Orb Chip enrollment contract.",
        roles: [
          {
            roleIndex: 1,
            signerName: name || email.split("@")[0],
            signerEmail: email,
            signerOrder: 1,
            signerType: "Signer",
            redirectUrl: redirectUrl,
          },
        ],
        disableEmails: true,
        redirectUrl: redirectUrl,
      }),
    });

    if (!createDocResponse.ok) {
      const errorText = await createDocResponse.text();
      let errorMessage = "Failed to create document from template";
      
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.message || errorJson.error || errorMessage;
      } catch (e) {
        // Error text is not JSON, use as-is
      }

      return NextResponse.json(
        {
          success: false,
          error: errorMessage,
          details: errorText,
        },
        { status: createDocResponse.status || 500 }
      );
    }

    const createDocumentData = await createDocResponse.json();
    const documentId = createDocumentData.documentId;
    
    if (!documentId) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to get document ID from Boldsign",
        },
        { status: 500 }
      );
    }

    const getSignLinkUrl = `${baseUrl}/document/getEmbeddedSignLink?documentId=${documentId}&signerEmail=${encodeURIComponent(email)}&redirectUrl=${encodeURIComponent(redirectUrl)}`;

    const signLinkResponse = await fetch(getSignLinkUrl, {
      method: "GET",
      headers: {
        "X-API-KEY": BOLDSIGN_API_KEY,
        accept: "application/json",
      },
    });

    if (!signLinkResponse.ok) {
      const errorText = await signLinkResponse.text();
      let errorMessage = "Failed to get signing link";
      
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.message || errorJson.error || errorMessage;
      } catch (e) {
        // Error text is not JSON, use as-is
      }

      return NextResponse.json(
        {
          success: false,
          error: errorMessage,
          details: errorText,
        },
        { status: signLinkResponse.status || 500 }
      );
    }

    const signLinkData = await signLinkResponse.json();
    const signingLink = signLinkData.signLink || signLinkData.signingUrl || signLinkData.url;

    if (!signingLink) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to get signing link from Boldsign",
        },
        { status: 500 }
      );
    }

    const expiresIn = signLinkData.expiresIn || 3600;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Save contract data to MongoDB
    let contractId: string | null = null;
    try {
      const db = await getDatabase();
      const contractsCollection = db.collection<BoldsignContract>("boldsignContracts");

      const contractData: BoldsignContract = {
        email,
        name: name || email.split("@")[0],
        documentId,
        signingLink,
        status: "pending",
        createdAt: new Date(),
        expiresAt,
        metadata: {
          sessionId: sessionId || undefined,
          callId: callId || undefined,
          redirectUrl,
          expiresIn,
        },
      };

      const insertResult = await contractsCollection.insertOne(contractData);
      contractId = insertResult.insertedId.toString();
    } catch (dbError: any) {
      // Log error but don't fail the request - contract creation was successful
      console.error("Failed to save contract to database:", dbError);
      // Return retry data in response so frontend can handle it
    }

    return NextResponse.json({
      success: true,
      signingLink,
      documentId,
      contractId,
      expiresIn,
      message: "Signing link created successfully",
      // Include retry data if DB save failed
      dbSaveFailed: !contractId,
      retryData: !contractId ? {
        email,
        name: name || email.split("@")[0],
        documentId,
        signingLink,
        callId,
        sessionId,
        expiresAt: expiresAt.toISOString(),
        expiresIn,
      } : undefined,
    });
  } catch (error: any) {
    console.error("Error creating signing link:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Internal server error",
      },
      { status: 500 }
    );
  }
}

