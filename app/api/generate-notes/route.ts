import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
    const { transcript, customVocab, frames = [] } = await req.json();

    if (!transcript?.trim()) {
        return NextResponse.json({ notes: '(Empty transcript — nothing was captured)' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
        return NextResponse.json({ notes: fallback(transcript, 'Gemini API key not set in .env.local') });
    }

    const prompt = `You are a professional meeting secretary for a software development team. Given the meeting transcript below, produce structured meeting notes in the following exact markdown format. Be concise, factual, and do not hallucinate anything not in the transcript.

**IMPORTANT MULTILINGUAL RULE**: The transcript contains a mix of Marathi, Hindi, and English. You must seamlessly understand all three languages and generate the final meeting notes entirely in clear, professional English.

---

## Summary
(2–3 sentences: what the meeting was about, who was involved if mentioned, and the main outcome)

## Minutes of Meeting (MOM)

### Topics Discussed
(Bullet list of each topic covered. If multiple speakers interact, try to summarize it conversationally: [Speaker A]: point, [Speaker B]: response.)

### Presenter & Screen Share Analysis
(You are receiving visual screenshots of what was presented! Carefully analyze the provided images. What is on the slides/screen? Summarize precisely what was shown and the conclusions drawn from the slides. If no images or slides are relevant, say so.)

## What Was Decided
(Bullet list of all decisions made during the meeting. If none, write: None recorded)

## To-Do / Action Items
(Bullet list. Each line: **[Person's name or Team]** — [specific task]. If due date mentioned, add it.)

## Results & Outcomes
(What did the team achieve or conclude from this meeting? What changed, what was resolved, what will happen next as a result?)

## Next Steps
(Bullet list of what happens after this meeting — follow-up meetings, reviews, releases, etc.)

---

Rules:
- Only include what is clearly stated in the transcript or visible in the screenshots. Do not guess blindly.
- **Speaker Diarization (CRITICAL):** The raw transcript does not have speaker tags. You MUST use conversational context (e.g. "Hey Ashish") OR the provided visual screenshots to identify who is speaking. Google Meet UI highlights the active speaker's name in the frames. Try your best to tag exact names to speakers instead of "Speaker 1"!
- If a section has nothing, write "None recorded" or "None detected".
- Keep language clear and professional.

**PHONETIC CORRECTION & CUSTOM VOCABULARY**: 
The transcript below is auto-generated and contains phonetic misspellings (e.g. interpreting "QRapid" as "kyon Rapid" or "Q rapid"). You must intelligently infer the correct technical terms, company names, and acronyms from the context.
${customVocab ? `\nWatch out for these specific CUSTOM VOCABULARY words for this meeting:\n[ ${customVocab} ]\nIf anything sounds remotely like these words, use these exact spellings in your notes.\n` : ''}
TRANSCRIPT:
${transcript.slice(0, 30000)}`;

    const parts: any[] = [{ text: prompt }];

    // Inject all captured base64 frames for multimodal visual analysis
    if (Array.isArray(frames) && frames.length > 0) {
        for (const base64Str of frames) {
            parts.push({
                inlineData: { mimeType: 'image/jpeg', data: base64Str }
            });
        }
    }

    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts }],
                    generationConfig: { temperature: 0.2, maxOutputTokens: 3000 },
                }),
            }
        );

        if (!res.ok) {
            const errText = await res.text();
            console.error('Gemini error:', errText);
            return NextResponse.json({ notes: fallback(transcript, `Gemini API Error: ${res.status} ${res.statusText}`) });
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('No structured content returned from Gemini');
        return NextResponse.json({ notes: text });

    } catch (err: any) {
        console.error('Gemini error:', err);
        return NextResponse.json({ notes: fallback(transcript, `AI Generation Failed: ${err.message}`) });
    }
}

function fallback(transcript: string, errorMsg: string): string {
    const words = transcript.trim().split(/\s+/).length;
    return [
        '## Summary',
        `(${errorMsg} — raw transcript stored below)`,
        '',
        '## Raw Transcript',
        transcript.trim(),
        '',
        '---',
        `_${words} words captured_`,
    ].join('\n');
}
