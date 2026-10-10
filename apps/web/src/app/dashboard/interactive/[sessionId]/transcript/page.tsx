'use client';

import { useParams } from 'next/navigation';
import { InteractiveTranscriptView } from './transcript-view';
import { useInteractiveTranscript } from './use-interactive-transcript';

function Transcript({ sessionId }: { sessionId: string }) {
  const transcript = useInteractiveTranscript(sessionId);
  return <InteractiveTranscriptView sessionId={sessionId} transcript={transcript} />;
}

export default function InteractiveTranscriptPage() {
  const params = useParams();
  const sessionId = params['sessionId'] as string;
  // Keyed so a different session id starts with entirely fresh state.
  return <Transcript key={sessionId} sessionId={sessionId} />;
}
