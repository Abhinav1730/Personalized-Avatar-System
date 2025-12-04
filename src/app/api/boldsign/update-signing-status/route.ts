import { NextRequest, NextResponse } from "next/server";
import { getDatabase } from "@/lib/mongodb";
import { BoldsignContract } from "@/models/BoldsignContract";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { documentId, status = "signed" } = body;

    if (!documentId) {
      return NextResponse.json(
        { success: false, error: "Document ID is required" },
        { status: 400 }
      );
    }

    try {
      const db = await getDatabase();
      const contractsCollection = db.collection<BoldsignContract>("boldsignContracts");

      const updateData: Partial<BoldsignContract> = {
        status: status as BoldsignContract["status"],
      };

      if (status === "signed") {
        updateData.signedAt = new Date();
      }

      const result = await contractsCollection.updateOne(
        { documentId },
        { $set: updateData }
      );

      if (result.matchedCount === 0) {
        return NextResponse.json(
          {
            success: false,
            error: "Contract not found",
          },
          { status: 404 }
        );
      }

      return NextResponse.json({
        success: true,
        message: "Contract status updated successfully",
        updated: result.modifiedCount > 0,
      });
    } catch (dbError: any) {
      console.error("Database error updating contract status:", dbError);
      
      return NextResponse.json(
        {
          success: false,
          error: "Failed to update contract status in database",
          details: dbError?.message || "Database connection error",
          // Include retry data
          retryData: {
            documentId,
            status,
          },
        },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error("Error updating contract status:", error);
    return NextResponse.json(
      {
        success: false,
        error: error?.message || "Internal server error",
      },
      { status: 500 }
    );
  }
}

