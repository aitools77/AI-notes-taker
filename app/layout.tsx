import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Notes Taker',
  description: 'Auto-transcribe and take AI notes from Google Meet.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
