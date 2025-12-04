import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/mongodb";
import { AvatarConversation } from "@/models/AvatarConversation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      callId,
      startTime,
      endTime,
      duration,
      transcript,
      messages,
      metadata,
    } = body;

    // Validate required fields
    if (!callId) {
      return NextResponse.json(
        { success: false, error: "Call ID is required" },
        { status: 400 }
      );
    }

    if (!transcript && (!messages || messages.length === 0)) {
      return NextResponse.json(
        { success: false, error: "Transcript or messages are required" },
        { status: 400 }
      );
    }

    if (!startTime || !endTime) {
      return NextResponse.json(
        { success: false, error: "Start time and end time are required" },
        { status: 400 }
      );
    }

    try {
      const db = await getDatabase();
      const conversationsCollection = db.collection<AvatarConversation>("avatarConversations");

      // Check if conversation with this callId already exists
      const existingConversation = await conversationsCollection.findOne({ callId });

      const conversationData: AvatarConversation = {
        callId,
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        duration: duration || Math.floor((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000),
        transcript: transcript || "",
        messages: messages || [],
        metadata: metadata || {},
        createdAt: new Date(),
      };

      let conversationId: string | undefined;
      if (existingConversation) {
        // Update existing conversation
        await conversationsCollection.updateOne(
          { callId },
          { $set: conversationData }
        );
        conversationId = existingConversation._id?.toString();
      } else {
        // Insert new conversation
        const result = await conversationsCollection.insertOne(conversationData);
        conversationId = result.insertedId.toString();
      }

      return NextResponse.json({
        success: true,
        message: "Conversation saved successfully",
        conversationId: conversationId,
      });
    } catch (dbError: any) {
      console.error("Database error saving conversation:", dbError);
      
      // Return error but include the data so frontend can retry
      return NextResponse.json(
        {
          success: false,
          error: "Failed to save conversation to database",
          details: dbError?.message || "Database connection error",
          // Include the data for retry mechanism
          retryData: {
            callId,
            startTime,
            endTime,
            duration,
            transcript,
            messages,
            metadata,
          },
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("Error saving conversation:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Internal server error",
      },
      { status: 500 }
    );
  }
}

