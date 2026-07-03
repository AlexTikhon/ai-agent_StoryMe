import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth/auth-context';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: {
    default: "StoryMe — Personalized AI Children's Books",
    template: '%s | StoryMe',
  },
  description:
    "Create personalized, beautifully illustrated children's books starring your child — powered by AI.",
  keywords: ["children's books", 'personalized', 'AI', 'kids', 'stories'],
  authors: [{ name: 'StoryMe' }],
  creator: 'StoryMe',
  metadataBase: new URL(process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    siteName: 'StoryMe',
    title: "StoryMe — Personalized AI Children's Books",
    description:
      "Create personalized, beautifully illustrated children's books starring your child.",
  },
  twitter: {
    card: 'summary_large_image',
    title: "StoryMe — Personalized AI Children's Books",
  },
};

interface RootLayoutProps {
  children: ReactNode;
}

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Preconnect for Google Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Load only the weights/styles used in the design system */}
        <link
          href={
            'https://fonts.googleapis.com/css2?' +
            'family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400' +
            '&family=Plus+Jakarta+Sans:wght@400;500;600;700' +
            '&family=Lora:ital,wght@0,400;0,600;1,400' +
            '&display=swap'
          }
          rel="stylesheet"
        />
      </head>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
