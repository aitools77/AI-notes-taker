import { NextResponse } from 'next/server';

export async function GET() {
    const key = process.env.GEMINI_API_KEY;
    const configured = Boolean(key && key !== 'your_gemini_api_key_here');
    return NextResponse.json({ configured });
}
