import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth/auth-context';
import '../styles/globals.css';

const SITE_TITLE = "StoryMe — Personalized Illustrated Children's Books";
const SITE_DESCRIPTION =
  'Create an illustrated storybook starring your child (ages 1–12), read it in your browser and download it as a PDF.';

export const metadata: Metadata = {
  title: {
    default: SITE_TITLE,
    template: '%s | StoryMe',
  },
  description: SITE_DESCRIPTION,
  keywords: ["children's books", 'personalized storybook', 'illustrated', 'picture book', 'PDF'],
  authors: [{ name: 'StoryMe' }],
  creator: 'StoryMe',
  metadataBase: new URL(process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'),
  openGraph: {
    type: 'website',
    siteName: 'StoryMe',
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_TITLE,
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
