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
type View = 'recorder' | 'session' | 'home';

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
  // ── Types ─────────────────────────────────────────────────────────────
  type View = 'recorder' | 'session' | 'home';

  // ── State ─────────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>([]);
  const [savedLinks, setSavedLinksS] = useState<SavedLink[]>([]);
  const [view, setView] = useState<View>('home');
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
  const [speechLangs, setSpeechLangs] = useState<string[]>(['en-IN', 'hi-IN', 'mr-IN']);
  const [openMeet, setOpenMeet] = useState(false);
  const [captureScreen, setCaptureScreen] = useState(false);
  const [customVocab, setCustomVocab] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editedNotes, setEditedNotes] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

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

    const q = query(collection(db, 'meetings'), where('user_id', '==', user.uid));
    const unsubscribeDb = onSnapshot(q, (snapshot) => {
      const dbSessions: Session[] = [];
      snapshot.forEach((docSnap) => {
        const d = docSnap.data();
        dbSessions.push({
          id: d.id,
          meetUrl: d.meet_url,
          date: d.created_at?.toDate ? d.created_at.toDate().toISOString() : d.created_at || new Date().toISOString(),
          durationSec: d.duration_sec,
          transcript: d.transcript,
          notes: d.notes,
          images: d.images
        });
      });
      // Sort in JS instead of Firestore strictly to avoid Composite Index requirements
      dbSessions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
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

    const uiSession: Session = {
      id: sid,
      meetUrl: url,
      date: date,
      durationSec: duration,
      transcript: final,
      notes: notes,
      images: capturedFrames
    };

    setSessions(prev => [uiSession, ...prev.filter(s => s.id !== sid)]);
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
    rec.continuous = true; rec.interimResults = true;
    rec.lang = speechLangs.join(',');
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
  if (authLoading) return <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: '#f9fafb', color: '#18181b' }}>Loading Platform...</div>;

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
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh', background: '#f9fafb', color: '#18181b', fontFamily: 'var(--font-inter)' }}>
        <div style={{ background: '#ffffff', padding: 32, borderRadius: 16, width: '100%', maxWidth: 400, border: '1px solid #e4e4e7' }}>
          <h2 style={{ fontSize: 24, fontWeight: 600, marginBottom: 8 }}>AI Notes Taker <span style={{ color: '#ec4899', fontSize: 18 }}>●</span></h2>
          <p style={{ color: '#52525b', marginBottom: 24, fontSize: 14 }}>
            {!linkSent ? 'Enter your email to sign in securely. We will send you a magic passwordless login link.' : (
              <span>
                <b>Login link sent!</b><br /><br />
                Please check your email inbox and click the link to sign in.<br /><br />
                <span style={{ color: '#b45309' }}>⚠️ If you don't see it, please check your <b>Spam</b> or <b>Junk</b> folder.</span>
              </span>
            )}
          </p>
          {!linkSent && (
            <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <input type="email" value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="name@company.com" required style={{ width: '100%', padding: '12px 16px', borderRadius: 8, background: '#f9fafb', border: '1px solid #e4e4e7', color: '#18181b', fontSize: 15, outline: 'none' }} />
              {authError && <div style={{ color: '#ef4444', fontSize: 13 }}>{authError}</div>}
              <button type="submit" style={{ padding: '12px 16px', borderRadius: 8, background: '#18181b', color: '#ffffff', fontWeight: 500, border: 'none', cursor: 'pointer', fontSize: 15, transition: '0.2s' }}>
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
      {/* ════ SIDEBAR ═══════════════════════════════════════════ */}
      <aside className={`sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
        <div className="sidebar-brand">
          AI Notes Taker <span style={{ marginRight: 'auto' }}>●</span>
          <button className="sidebar-close-btn" onClick={() => setIsSidebarOpen(false)}>✕</button>
        </div>

        {/* New meeting button */}
        <button
          className="sidebar-new-btn"
          onClick={() => { setView('home'); setActiveId(null); phase === 'idle' }}
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
                onClick={() => { setMeetUrl(link.url); setView('home'); setActiveId(null); }}
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
                style={{ width: '100%', background: '#ffffff', border: '1px solid var(--panel-border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: '#3f3f46', outline: 'none', marginBottom: 4 }}
              />
              <input
                type="text"
                placeholder="Name (optional)"
                value={newLinkLabel}
                onChange={e => setNewLinkLabel(e.target.value)}
                style={{ width: '100%', background: '#ffffff', border: '1px solid var(--panel-border)', borderRadius: 6, padding: '6px 8px', fontSize: 12, color: '#3f3f46', outline: 'none', marginBottom: 6 }}
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

        {/* User Profile Footer */}
        <div className="user-profile-badge">
          <div className="user-avatar">{user.email?.charAt(0).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: '#18181b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {user.email?.split('@')[0]}
            </div>
            <button className="btn-link" style={{ fontSize: 11, color: '#52525b', padding: 0 }} onClick={() => signOut(auth)}>Sign Out</button>
          </div>
        </div>
      </aside>

      {/* ════ MAIN ══════════════════════════════════════════════ */}
      <main className="main">
        <div className="topbar">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <button className="sidebar-toggle-btn" onClick={() => setIsSidebarOpen(!isSidebarOpen)}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#18181b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
            </button>
            <div className="topbar-greeting">
              <h1>Welcome Back, {user.email?.split('@')[0]}</h1>
              <p>Ready to capture some insights?</p>
            </div>
          </div>
        </div>

        <div className="main-inner">

          {/* ── Dashboard Grid (Home / Recorder) ─────────────────────────── */}
          {(view === 'home' || view === 'recorder') && (
            <div className="dashboard-grid">
              {/* LEFT COLUMN */}
              <div className="dashboard-col">

                {/* NEW MEETING PANEL */}
                <div className="card-panel">
                  <h2 className="card-title">Capture Online Meeting</h2>

                  {!isActive && phase !== 'generating' && (
                    <>
                      {/* API key warning */}
                      {!hasApiKey && (
                        <div className="api-key-banner" style={{ background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                          <span>⚠️ Gemini API key not set — notes will be saved as raw transcript only.</span>
                        </div>
                      )}

                      <div className="join-box" style={{ marginTop: 24 }}>
                        <div style={{ display: 'flex', alignItems: 'center', background: '#ffffff', border: '1px solid var(--panel-border)', borderRadius: 12, padding: '4px 16px', flex: 1, gap: 12 }}>
                          <input
                            type="url"
                            placeholder="Paste your meeting URL here (Google Meet, Zoom, etc.)"
                            value={meetUrl}
                            onChange={e => setMeetUrl(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleJoin(); }}
                            style={{ flex: 1, background: 'transparent', border: 'none', color: '#18181b', fontSize: 14, outline: 'none', padding: '12px 0' }}
                          />
                        </div>
                        <button className="btn-primary" onClick={handleJoin} disabled={!meetUrl.trim()} style={{ borderRadius: 12, padding: '0 24px', flexShrink: 0 }}>
                          Start Capturing
                        </button>
                      </div>

                      <div className="form-grid">
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 12, color: '#71717a', marginBottom: 6, display: 'block' }}>Name your meeting (optional)</label>
                          <input type="text" placeholder="Eg: All Hands" style={{ width: '100%', background: 'transparent', border: '1px solid var(--panel-border)', borderRadius: 10, padding: '10px 14px', fontSize: 14, color: '#18181b', outline: 'none' }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 12, color: '#71717a', marginBottom: 6, display: 'block' }}>Meeting Languages (Multi-select)</label>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            {[
                              { code: 'en-IN', label: '🇺🇸 English' },
                              { code: 'hi-IN', label: '🇮🇳 Hindi' },
                              { code: 'mr-IN', label: '🇮🇳 Marathi' }
                            ].map(lang => {
                              const isSelected = speechLangs.includes(lang.code);
                              return (
                                <button
                                  key={lang.code}
                                  onClick={() => {
                                    if (isSelected && speechLangs.length > 1) {
                                      setSpeechLangs(speechLangs.filter(l => l !== lang.code));
                                    } else if (!isSelected) {
                                      setSpeechLangs([...speechLangs, lang.code]);
                                    }
                                  }}
                                  style={{
                                    background: isSelected ? 'rgba(139, 92, 246, 0.2)' : '#ffffff',
                                    border: `1px solid ${isSelected ? 'var(--accent-primary)' : '#e4e4e7'}`,
                                    color: isSelected ? '#fff' : '#a1a1aa',
                                    padding: '8px 12px',
                                    borderRadius: '8px',
                                    fontSize: '13px',
                                    cursor: 'pointer',
                                    transition: 'all 0.2s'
                                  }}
                                >
                                  {lang.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>

                      <details style={{ marginTop: 24 }}>
                        <summary style={{ fontSize: 13, color: 'var(--accent-primary)', cursor: 'pointer', outline: 'none' }}>Advanced Capture Settings</summary>
                        <div style={{ marginTop: 12, padding: 16, background: '#ffffff', borderRadius: 12, border: '1px solid var(--panel-border)' }}>
                          <div style={{ marginBottom: 16 }}>
                            <input type="text" placeholder="Custom Vocab (e.g. Next.js, ACME)" value={customVocab} onChange={e => setCustomVocab(e.target.value)} style={{ width: '100%', background: 'transparent', border: '1px solid var(--panel-border)', borderRadius: 8, padding: '8px 12px', fontSize: 13, color: '#18181b', outline: 'none' }} />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13, color: '#71717a' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                              <input type="checkbox" checked={openMeet} onChange={e => setOpenMeet(e.target.checked)} />
                              Open link in a new Meet tab
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: captureScreen ? 'var(--accent-primary)' : '' }}>
                              <input type="checkbox" checked={captureScreen} onChange={e => setCaptureScreen(e.target.checked)} />
                              Capture Video/Slides (Vision AI)
                            </label>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, fontSize: 12, color: '#71717a' }}>
                            Stop after
                            <select value={silenceLimit} onChange={e => setSilenceLimit(Number(e.target.value))} style={{ background: 'transparent', border: '1px solid var(--panel-border)', color: '#71717a', borderRadius: 4, padding: '2px 4px' }}>
                              <option value={5}>5m</option><option value={10}>10m</option><option value={30}>30m</option>
                            </select>
                            silence
                          </div>
                        </div>
                      </details>
                    </>
                  )}

                  {/* ACTIVE RECORDING STATE OVERLAY */}
                  {isActive && (
                    <div style={{ padding: 24, background: 'rgba(139, 92, 246, 0.05)', borderRadius: 12, border: '1px solid rgba(139, 92, 246, 0.2)' }}>
                      <div className="status-bar" style={{ marginBottom: 20 }}>
                        <span className="dot" />
                        <span style={{ color: '#18181b', fontWeight: 500, fontSize: 14 }}>Recording Live — {fmtDuration(elapsed)}</span>
                      </div>

                      {openMeet && (
                        <div className="warning-banner" style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#dc2626', border: '1px solid rgba(239, 68, 68, 0.2)', marginBottom: 20 }}>
                          <strong style={{ fontSize: 13 }}>🚨 Mute yourself in the Google Meet tab to prevent echo!</strong>
                        </div>
                      )}

                      <div className="transcript-box" style={{ background: '#ffffff' }}>
                        {transcript ? <>{transcript}<span className="interim">{interim}</span></> : <span className="placeholder">Listening to meeting audio...</span>}
                      </div>

                      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
                        <button className="btn-primary" onClick={stopAndSave} style={{ flex: 1, padding: 12 }}>Finish & Generate Notes</button>
                      </div>
                    </div>
                  )}

                  {phase === 'generating' && (
                    <div style={{ padding: 40, textAlign: 'center', background: '#ffffff', borderRadius: 12, border: '1px solid var(--panel-border)' }}>
                      <span className="dot amber" style={{ width: 12, height: 12, margin: '0 auto 16px' }} />
                      <div style={{ color: '#18181b', fontSize: 15, fontWeight: 500 }}>AI is processing your meeting...</div>
                      <div style={{ color: '#71717a', fontSize: 13, marginTop: 8 }}>Structuring notes, extracting action items, and saving to cloud.</div>
                    </div>
                  )}
                </div>

              </div>

            </div>
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
                      <button className="btn-link" style={{ color: '#52525b' }} onClick={() => setIsEditing(false)}>Cancel</button>
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
                    <div style={{ marginTop: 32, paddingTop: 32, borderTop: '1px solid #e4e4e7' }}>
                      <h3 style={{ marginBottom: 16, fontSize: 16, fontWeight: 500, color: '#18181b' }}>Captured Presentation Slides</h3>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                        {activeSession.images.map((base64, i) => (
                          <img key={i} src={`data:image/jpeg;base64,${base64}`} alt={`Captured slide ${i + 1}`} style={{ width: '100%', borderRadius: 8, border: '1px solid #e4e4e7', background: '#f4f4f5' }} />
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
                    width: '100%', minHeight: '400px', background: '#ffffff', color: '#3f3f46',
                    border: '1px solid #e4e4e7', borderRadius: 8, padding: 16, fontSize: 13,
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
