'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, isSignInWithEmailLink, signInWithEmailLink, sendSignInLinkToEmail, User, signOut, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, collection, doc, setDoc, updateDoc, deleteDoc, query, where, orderBy, onSnapshot, serverTimestamp } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyCfWEeFe561ZzdKZPShVM39aXdtTCN_PUQ",
  authDomain: "ai-notes-taker-7.firebaseapp.com",
  projectId: "ai-notes-taker-7",
  storageBucket: "ai-notes-taker-7.firebasestorage.app",
  messagingSenderId: "877453863570",
  appId: "1:877453863570:web:bdf0a093a915ebb06cd44b",
  measurementId: "G-NJ8T2R4CCN"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ─── Types ────────────────────────────────────────────────────────────────────
interface Session {
  id: string;
  meetUrl: string;
  date: string;
  durationSec: number;
  transcript: string;
  notes: string;
  images?: string[];
  created_at?: any; // Firestore serverTimestamp
}

interface SavedLink {
  id: string;
  url: string;
  label: string;
}

type Phase = 'idle' | 'recording' | 'warning' | 'generating';
type View = 'recorder' | 'session';

// ─── Storage ──────────────────────────────────────────────────────────────────
function getSavedLinks(): SavedLink[] {
  try { return JSON.parse(localStorage.getItem('aint_links') || '[]'); } catch { return []; }
}
function setSavedLinks(links: SavedLink[]) {
  localStorage.setItem('aint_links', JSON.stringify(links));
}

// ─── Formatting ───────────────────────────────────────────────────────────────
function fmtSidebarDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
}
function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function shortUrl(url: string) {
  try {
    const code = new URL(url).pathname.replace(/^\//, '');
    return code || url;
  } catch { return url; }
}

// ─── Minimal Markdown → HTML ──────────────────────────────────────────────────
function md(text: string): string {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .split(/(?=<ul>)|(?<=<\/ul>)/)
    .map(s => s.startsWith('<li>') ? `<ul>${s}</ul>` : s)
    .join('')
    .replace(/\n{2,}/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_SILENCE_MIN = 20;
const WARN_GRACE_SEC = 60;

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ─────────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>([]);
  const [savedLinks, setSavedLinksS] = useState<SavedLink[]>([]);
  const [view, setView] = useState<View>('recorder');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [meetUrl, setMeetUrl] = useState('');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [silence, setSilence] = useState(0);
  const [silenceLimit, setSilenceLimit] = useState(DEFAULT_SILENCE_MIN);
  const [warnCount, setWarnCount] = useState(WARN_GRACE_SEC);
  const [toast, setToast] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkLabel, setNewLinkLabel] = useState('');
  const [addingLink, setAddingLink] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [speechLang, setSpeechLang] = useState('en-IN'); // defaults to English so live text isn't Devanagari
  const [openMeet, setOpenMeet] = useState(false);
  const [captureScreen, setCaptureScreen] = useState(false);
  const [customVocab, setCustomVocab] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedNotes, setEditedNotes] = useState('');

  // ── Auth & Firebase State ─────────────────────────────────────────────────
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  const [authError, setAuthError] = useState('');

  // ── Refs shared across closures ───────────────────────────────────────────
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const startRef = useRef(0);
  const lastSpeechRef = useRef(0);
  const transcriptRef = useRef('');
  const phaseRef = useRef<Phase>('idle');
  const sessionRef = useRef<{ id: string; meetUrl: string; date: string } | null>(null);

  // Screen capture refs
  const streamRef = useRef<MediaStream | null>(null);
  const framesRef = useRef<string[]>([]);
  const captureIntervalRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  transcriptRef.current = transcript;
  phaseRef.current = phase;

  // ── Load from storage on mount ────────────────────────────────────────────
  useEffect(() => {
    setSavedLinksS(getSavedLinks());
    fetch('/api/check-key')
      .then(r => r.json())
      .then(d => setHasApiKey(Boolean(d.configured)))
      .catch(() => setHasApiKey(false));

    // Firebase Auth Magic Link handler
    if (isSignInWithEmailLink(auth, window.location.href)) {
      let email = window.localStorage.getItem('emailForSignIn');
      if (!email) email = window.prompt('Please provide your email for confirmation');
      if (email) {
        signInWithEmailLink(auth, email, window.location.href)
          .then(() => { window.localStorage.removeItem('emailForSignIn'); window.history.replaceState({}, document.title, '/'); })
          .catch((err) => setAuthError(err.message));
      }
    }

    // Firebase Auth State Listener
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });

    return () => unsubscribeAuth();
  }, []);

  // ── Listen to Firestore Meetings ──────────────────────────────────────────
  useEffect(() => {
    if (!user) { setSessions([]); return; }

    const q = query(collection(db, 'meetings'), where('user_id', '==', user.uid), orderBy('created_at', 'desc'));
    const unsubscribeDb = onSnapshot(q, (snapshot) => {
      const dbSessions: Session[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        dbSessions.push({
          id: d.id,
          meetUrl: d.meet_url,
          date: d.created_at?.toDate ? d.created_at.toDate().toISOString() : new Date().toISOString(),
          durationSec: d.duration_sec,
          transcript: d.transcript,
          notes: d.notes,
          images: d.images
        });
      });
      setSessions(dbSessions);
    });

    return () => unsubscribeDb();
  }, [user]);

  // ── Elapsed + silence ticker ──────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'warning') return;
    const t = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      const silSec = Math.floor((Date.now() - lastSpeechRef.current) / 1000);
      setSilence(silSec);
      if (phaseRef.current === 'recording' && silSec >= silenceLimit * 60) {
        setPhase('warning'); phaseRef.current = 'warning';
        setWarnCount(WARN_GRACE_SEC);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [phase, silenceLimit]);

  // ── Warning countdown ─────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'warning') return;
    const t = setInterval(() => {
      setWarnCount(prev => {
        if (prev <= 1) { clearInterval(t); stopAndSave(); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  // ── Stop & generate ───────────────────────────────────────────────────────
  const stopAndSave = useCallback(async () => {
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }

    // Stop screen capture
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current = null;
    }

    const final = transcriptRef.current.trim();
    const duration = Math.floor((Date.now() - startRef.current) / 1000);
    const sid = sessionRef.current?.id || Date.now().toString();
    const date = sessionRef.current?.date || new Date().toISOString();
    const url = sessionRef.current?.meetUrl || '';
    const capturedFrames = [...framesRef.current];
    framesRef.current = [];

    setPhase('generating'); phaseRef.current = 'generating';

    if (!final) {
      showToast('No speech detected — session not saved.');
      setPhase('idle'); phaseRef.current = 'idle';
      return;
    }

    let notes = '';
    try {
      const res = await fetch('/api/generate-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: final, customVocab, frames: capturedFrames }),
      });
      notes = (await res.json()).notes || '';
    } catch {
      notes = '(AI notes generation failed — raw transcript saved below)';
    }

    const sessionPayload: any = {
      id: sid,
      user_id: user?.uid,
      meet_url: url,
      transcript: final,
      notes,
      images: capturedFrames,
      duration_sec: duration,
      created_at: date
    };

    if (user) {
      await setDoc(doc(db, 'meetings', sid), sessionPayload);
    }

    setActiveId(sid);
    setView('session');
    setPhase('idle'); phaseRef.current = 'idle';
    setMeetUrl('');
    sessionRef.current = null;
    showToast('Meeting notes saved securely to Cloud!');
  }, [user, customVocab]);

  // ── Start recording ───────────────────────────────────────────────────────
  const startRecording = useCallback(async (url: string) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showToast('Use Chrome or Edge — speech recognition not supported here.'); return; }

    // ── Request mic with echo cancellation FIRST ─────────────────────────────
    // This primes the browser's audio pipeline so SpeechRecognition inherits
    // echo cancellation + noise suppression, preventing feedback from speakers.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      // We only needed this to configure the audio pipeline; stop the tracks.
      stream.getTracks().forEach(t => t.stop());
    } catch (err: any) {
      showToast('Mic permission denied — please allow microphone access.');
      return;
    }

    if (openMeet && url) {
      window.open(url, '_blank', 'noopener');
    }

    if (captureScreen) {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' } });
        streamRef.current = stream;
        const video = document.createElement('video');
        video.srcObject = stream;
        video.play();
        videoRef.current = video;

        captureIntervalRef.current = setInterval(() => {
          if (video.videoWidth) {
            const canvas = document.createElement('canvas');
            const scale = Math.min(800 / video.videoWidth, 1);
            canvas.width = Math.floor(video.videoWidth * scale);
            canvas.height = Math.floor(video.videoHeight * scale);
            const ctx = canvas.getContext('2d');
            ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
            const base64 = canvas.toDataURL('image/jpeg', 0.5).split(',')[1];
            if (framesRef.current.length < 30) framesRef.current.push(base64); // max ~15 mins of frames
          }
        }, 30000); // capture every 30s
      } catch (err) {
        showToast('Screen capture skipped or denied.');
        setCaptureScreen(false);
      }
    }

    const id = Date.now().toString();
    const date = new Date().toISOString();
    sessionRef.current = { id, meetUrl: url, date };
    startRef.current = Date.now();
    lastSpeechRef.current = Date.now();

    setTranscript(''); setInterim(''); setElapsed(0); setSilence(0);

    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = speechLang;
    recognitionRef.current = rec;

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let fin = '', inter = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' ';
        else inter += e.results[i][0].transcript;
      }
      if (fin) {
        setTranscript(prev => prev + fin);
        lastSpeechRef.current = Date.now();
        setSilence(0);
        if (phaseRef.current === 'warning') { setPhase('recording'); phaseRef.current = 'recording'; }
      }
      setInterim(inter);
    };
    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      if (e.error !== 'no-speech') showToast(`Mic: ${e.error}`);
    };
    rec.onend = () => {
      if (recognitionRef.current === rec && (phaseRef.current === 'recording' || phaseRef.current === 'warning')) {
        try { rec.start(); } catch { /* ignore */ }
      }
    };
    rec.start();
    setPhase('recording'); phaseRef.current = 'recording';
    setView('recorder');
  }, []);

  const handleJoin = () => {
    if (!meetUrl.trim()) return;
    startRecording(meetUrl.trim());
  };

  const handleKeepRecording = () => {
    lastSpeechRef.current = Date.now();
    setSilence(0); setWarnCount(WARN_GRACE_SEC);
    setPhase('recording'); phaseRef.current = 'recording';
  };

  // ── Saved links ───────────────────────────────────────────────────────────
  const handleAddLink = () => {
    if (!newLinkUrl.trim()) return;
    const link: SavedLink = {
      id: Date.now().toString(),
      url: newLinkUrl.trim(),
      label: newLinkLabel.trim() || shortUrl(newLinkUrl.trim()),
    };
    const updated = [...savedLinks, link].slice(0, 5); // max 5
    setSavedLinksS(updated);
    setSavedLinks(updated);
    setNewLinkUrl(''); setNewLinkLabel(''); setAddingLink(false);
  };
  const handleDeleteLink = (id: string) => {
    const updated = savedLinks.filter(l => l.id !== id);
    setSavedLinksS(updated);
    setSavedLinks(updated);
  };

  // ── Delete session ────────────────────────────────────────────────────────
  const handleDeleteSession = async (id: string) => {
    if (user) {
      try {
        await deleteDoc(doc(db, 'meetings', id));
        if (activeId === id) { setActiveId(null); setView('recorder'); }
      } catch (e) {
        showToast('Failed to delete meeting from cloud');
      }
    }
  };

  const isActive = phase === 'recording' || phase === 'warning';
  const activeSession = sessions.find(s => s.id === activeId);

  // ── Login UI ──────────────────────────────────────────────────────────────
  if (authLoading) return <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: '#0a0a0a', color: '#fff' }}>Loading Platform...</div>;

  if (!user) {
    const handleLogin = async (e: React.FormEvent) => {
      e.preventDefault();
      setAuthError('');
      const actionCodeSettings = {
        url: window.location.origin,
        handleCodeInApp: true,
      };
      try {
        await sendSignInLinkToEmail(auth, loginEmail, actionCodeSettings);
        window.localStorage.setItem('emailForSignIn', loginEmail);
        setLinkSent(true);
      } catch (err: any) {
        setAuthError(err.message);
      }
    };

    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: '#0a0a0a', color: '#fff', fontFamily: 'var(--font-inter)' }}>
        <div style={{ background: '#171717', padding: 32, borderRadius: 16, width: '100%', maxWidth: 400, border: '1px solid #262626' }}>
          <h2 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>AI Notes Taker <span style={{ color: '#ec4899', fontSize: 18 }}>●</span></h2>
          <p style={{ color: '#a3a3a3', marginBottom: 24, fontSize: 14 }}>
            {!linkSent ? 'Enter your email to sign in securely. We will send you a magic passwordless login link.' : (
              <span>
                <b>Login link sent!</b><br /><br />
                Please check your email inbox and click the link to sign in.<br /><br />
                <span style={{ color: '#fcd34d' }}>⚠️ If you don't see it, please check your <b>Spam</b> or <b>Junk</b> folder.</span>
              </span>
            )}
          </p>
          {!linkSent && (
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="name@company.com" required style={{ width: '100%', padding: '12px 16px', borderRadius: 8, background: '#0a0a0a', border: '1px solid #333', color: '#fff', fontSize: 15, outline: 'none' }} />
              {authError && <div style={{ color: '#ef4444', fontSize: 13 }}>{authError}</div>}
              <button type="submit" style={{ padding: '12px 16px', borderRadius: 8, background: '#fff', color: '#000', fontWeight: 500, border: 'none', cursor: 'pointer', fontSize: 15, transition: '0.2s' }}>
                Send Magic Link
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // ── Render Main App ───────────────────────────────────────────────────────
  return (
    <>
      <div style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999, display: 'flex', gap: 12, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: '#666' }}>{user.email}</span>
        <button className="btn-link" style={{ fontSize: 13, color: '#888' }} onClick={() => signOut(auth)}>Sign Out</button>
      </div>
      {/* ════ SIDEBAR ═══════════════════════════════════════════ */}
      <aside className="sidebar">
        <div className="sidebar-brand">AI Notes Taker <span>●</span></div>

        {/* New meeting button */}
        <button
          className="sidebar-new-btn"
          onClick={() => { setView('recorder'); setActiveId(null); }}
        >
          <span className="icon">＋</span> New Recording
        </button>

        {/* Saved / favourite links */}
        <div className="saved-links-section">
          <div className="saved-links-label">Quick Join</div>
          {savedLinks.map(link => (
            <div key={link.id} className="saved-link-item" title={link.url}>
              <span className="saved-link-dot" />
              <span
                className="saved-link-name"
                onClick={() => { setMeetUrl(link.url); startRecording(link.url); }}
              >
                {link.label}
              </span>
              <button className="saved-link-del" onClick={() => handleDeleteLink(link.id)}>✕</button>
            </div>
          ))}

          {/* Add link form */}
          {addingLink ? (
            <div style={{ marginTop: 6 }}>
              <input
                type="url"
                placeholder="meet.google.com/..."
                value={newLinkUrl}
                onChange={e => setNewLinkUrl(e.target.value)}
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #2d2d2d', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: '#ccc', outline: 'none', marginBottom: 4 }}
              />
              <input
                type="text"
                placeholder="Name (optional)"
                value={newLinkLabel}
                onChange={e => setNewLinkLabel(e.target.value)}
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #2d2d2d', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: '#ccc', outline: 'none', marginBottom: 6 }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn-primary btn-sm" style={{ flex: 1 }} onClick={handleAddLink}>Save</button>
                <button className="btn-ghost btn-sm" onClick={() => setAddingLink(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            savedLinks.length < 5 && (
              <button className="btn-link" style={{ paddingLeft: 4, marginTop: 4 }} onClick={() => setAddingLink(true)}>
                + Add link
              </button>
            )
          )}
        </div>

        {/* History */}
        <div className="sidebar-history">
          {sessions.length > 0 && <div className="history-label">History</div>}
          {sessions.map(s => (
            <div
              key={s.id}
              className={`history-item ${activeId === s.id && view === 'session' ? 'active' : ''}`}
              onClick={() => { setActiveId(s.id); setView('session'); setIsEditing(false); }}
              onMouseEnter={() => setHoveredId(s.id)}
              onMouseLeave={() => setHoveredId(null)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="history-item-date">{fmtSidebarDate(s.date)}</div>
                <div className="history-item-dur">{fmtDuration(s.durationSec)} · {shortUrl(s.meetUrl)}</div>
              </div>
              {hoveredId === s.id && (
                <button
                  className="history-del-btn"
                  title="Delete"
                  onClick={e => { e.stopPropagation(); handleDeleteSession(s.id); }}
                >✕</button>
              )}
            </div>
          ))}
        </div>
      </aside>

      {/* ════ MAIN ══════════════════════════════════════════════ */}
      <main className="main">
        <div className="main-inner">

          {/* ── Recorder view ─────────────────────────────────── */}
          {view === 'recorder' && (
            <>
              {/* API key warning */}
              {!hasApiKey && !isActive && (
                <div className="api-key-banner">
                  <span>⚠️ Gemini API key not set — notes will be saved as raw transcript only.</span>
                  <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" style={{ color: '#93c5fd', marginLeft: 8 }}>Get free key →</a>
                  <span style={{ color: '#555', marginLeft: 4 }}>then add to <code style={{ background: '#111', padding: '1px 5px', borderRadius: 4 }}>.env.local</code> and restart</span>
                </div>
              )}

              <p className="recorder-title">
                {isActive ? 'Recording in progress…' : 'Start a new recording'}
              </p>
              <p className="recorder-sub">
                {isActive
                  ? 'Listening. Switch to your Meet tab and talk. (Or stay here if you are on the same device).'
                  : 'Start recording below.'}
              </p>

              {!isActive && (
                <>
                  <div className="join-box">
                    <input
                      type="url"
                      placeholder="Meeting URL (optional)"
                      value={meetUrl}
                      onChange={e => setMeetUrl(e.target.value)}
                      disabled={phase === 'generating'}
                      onKeyDown={e => { if (e.key === 'Enter') handleJoin(); }}
                    />
                    <button className="btn-primary" onClick={handleJoin} disabled={phase === 'generating' || !meetUrl.trim()}>
                      {phase === 'generating' ? 'Generating…' : 'Start Recording'}
                    </button>
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <input
                      type="text"
                      placeholder="Custom Vocabulary (comma-separated, e.g. QRapid, Next.js, ACME Corp)"
                      value={customVocab}
                      onChange={e => setCustomVocab(e.target.value)}
                      disabled={phase === 'generating'}
                      style={{ width: '100%', background: '#1a1a1a', border: '1px solid #2d2d2d', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#e8e8e8', outline: 'none', transition: 'border-color 0.15s' }}
                    />
                    <div style={{ fontSize: 11, color: '#555', marginTop: 4, paddingLeft: 4 }}>
                      Helps the AI correct phonetic mistakes (like "kyon rapid" → "QRapid")
                    </div>
                  </div>
                  <div style={{ marginBottom: 20, fontSize: 13, color: '#aaa', display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={openMeet} onChange={e => setOpenMeet(e.target.checked)} />
                      Open this link in a new Google Meet tab
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: captureScreen ? '#93c5fd' : '#aaa' }}>
                      <input type="checkbox" checked={captureScreen} onChange={e => setCaptureScreen(e.target.checked)} />
                      <strong>Capture Video/Slides (Vision AI)</strong> — asks for Screen Share to analyze presentations!
                    </label>
                  </div>
                  <div className="settings-row">
                    <span>Language:</span>
                    <select value={speechLang} onChange={e => setSpeechLang(e.target.value)} style={{ marginRight: 16 }}>
                      <option value="en-IN">English (India)</option>
                      <option value="hi-IN">Hindi / English mix</option>
                      <option value="mr-IN">Marathi / English mix</option>
                    </select>

                    <span>Auto-stop after</span>
                    <select value={silenceLimit} onChange={e => setSilenceLimit(Number(e.target.value))}>
                      <option value={5}>5 min</option>
                      <option value={10}>10 min</option>
                      <option value={20}>20 min</option>
                      <option value={30}>30 min</option>
                      <option value={60}>60 min</option>
                    </select>
                    <span>silence</span>
                  </div>
                </>
              )}

              {/* Status */}
              {phase === 'recording' && (
                <div className="status-bar">
                  <span className="dot" />
                  <span>Recording — {fmtDuration(elapsed)}</span>
                  {silence > 60 && <span className="silence-note">· silent {fmtDuration(silence)}</span>}
                </div>
              )}
              {phase === 'generating' && (
                <div className="status-bar">
                  <span className="dot amber" />
                  <span>Generating meeting notes with AI…</span>
                </div>
              )}

              {/* Warning */}
              {phase === 'warning' && (
                <div className="warning-banner">
                  <span><strong>No speech for {fmtDuration(silence)}.</strong> Auto-stopping in {warnCount}s…</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn-ghost btn-sm" onClick={handleKeepRecording}>Keep Recording</button>
                    <button className="btn-danger btn-sm" onClick={stopAndSave}>Stop Now</button>
                  </div>
                </div>
              )}

              {isActive && (
                <>
                  {openMeet && (
                    <div className="warning-banner" style={{ background: '#3a0808', color: '#ffb3b3', border: '1px solid #701010', marginBottom: '20px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
                      <strong style={{ fontSize: 14 }}>🚨 How to fix the Echo:</strong>
                      <span>1. Go to the newly opened Google Meet tab.</span>
                      <span>2. Click the <strong>Microphone icon to MUTE</strong> yourself in that tab.</span>
                      <span>3. Talk from your main laptop/app. This notepad will still hear you perfectly in the background but won't feed the audio back into the meeting!</span>
                    </div>
                  )}
                  <div className="transcript-box">
                    {transcript
                      ? <>{transcript}<span className="interim">{interim}</span></>
                      : <span className="placeholder">Waiting for speech…</span>
                    }
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn-danger" onClick={stopAndSave}>Stop & Save Notes</button>
                    <button className="btn-ghost btn-sm" onClick={() => { setTranscript(''); lastSpeechRef.current = Date.now(); }}>Clear</button>
                  </div>
                </>
              )}

              {!isActive && phase !== 'generating' && sessions.length === 0 && (
                <div className="empty">No sessions yet.<br />Join a meeting to get started.</div>
              )}
            </>
          )}

          {/* ── Session / Notes view ───────────────────────────── */}
          {view === 'session' && activeSession && (
            <>
              <div className="notes-header">
                <h1>{fmtSidebarDate(activeSession.date)}</h1>
                <div className="notes-meta">
                  <span>⏱ {fmtDuration(activeSession.durationSec)}</span>
                  <span>🔗 {shortUrl(activeSession.meetUrl)}</span>

                  {!isEditing ? (
                    <button className="btn-link" style={{ marginLeft: 'auto' }} onClick={() => { setIsEditing(true); setEditedNotes(activeSession.notes); }}>
                      Edit Notes
                    </button>
                  ) : (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <button className="btn-link" style={{ color: '#888' }} onClick={() => setIsEditing(false)}>Cancel</button>
                      <button className="btn-link" style={{ color: '#3b82f6' }} onClick={async () => {
                        if (user) {
                          try {
                            await updateDoc(doc(db, 'meetings', activeSession.id), { notes: editedNotes });
                            setIsEditing(false);
                            showToast('Notes updated in Cloud!');
                          } catch (e) {
                            showToast('Failed to update notes');
                          }
                        }
                      }}>Save Changes</button>
                    </div>
                  )}

                  <button
                    className="btn-link"
                    style={{ color: '#ef4444', marginLeft: isEditing ? 0 : 16 }}
                    onClick={() => handleDeleteSession(activeSession.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {!isEditing ? (
                <>
                  <div className="notes-content" dangerouslySetInnerHTML={{ __html: md(activeSession.notes) }} />
                  {activeSession.images && activeSession.images.length > 0 && (
                    <div style={{ marginTop: 32, paddingTop: 32, borderTop: '1px solid #333' }}>
                      <h3 style={{ marginBottom: 16, fontSize: 16, fontWeight: 500, color: '#e8e8e8' }}>Captured Presentation Slides</h3>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                        {activeSession.images.map((base64, i) => (
                          <img key={i} src={`data:image/jpeg;base64,${base64}`} alt={`Captured slide ${i + 1}`} style={{ width: '100%', borderRadius: 8, border: '1px solid #444', background: '#000' }} />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <textarea
                  value={editedNotes}
                  onChange={e => setEditedNotes(e.target.value)}
                  style={{
                    width: '100%', minHeight: '400px', background: '#111', color: '#ccc',
                    border: '1px solid #333', borderRadius: 8, padding: 16, fontSize: 13,
                    fontFamily: 'monospace', lineHeight: 1.6, outline: 'none'
                  }}
                />
              )}

              {activeSession.transcript && !isEditing && (
                <details className="raw-toggle">
                  <summary>Show raw transcript</summary>
                  <pre className="raw-transcript">{activeSession.transcript}</pre>
                </details>
              )}
            </>
          )}

          {view === 'session' && !activeSession && (
            <div className="empty">Select a session from the sidebar.</div>
          )}
        </div>
      </main>

      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
