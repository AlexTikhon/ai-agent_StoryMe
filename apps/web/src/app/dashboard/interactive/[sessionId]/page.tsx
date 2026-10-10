'use client';

import { useParams } from 'next/navigation';
import { InteractiveReaderView } from './reader-view';
import { useInteractiveReader } from './use-interactive-reader';

function Reader({ sessionId }: { sessionId: string }) {
  const reader = useInteractiveReader(sessionId);
  return <InteractiveReaderView reader={reader} />;
}

export default function InteractiveReaderPage() {
  const params = useParams();
  const sessionId = params['sessionId'] as string;
  // Keyed so a different session id starts with entirely fresh reader state.
  return <Reader key={sessionId} sessionId={sessionId} />;
}
