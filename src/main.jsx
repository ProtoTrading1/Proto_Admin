import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import './index.css';
import Root from './Root.jsx';
import { installChunkLoadRecovery } from './lib/lazyRetry';
import { installPreviewWriteGuard } from './lib/previewWriteGuard';

installChunkLoadRecovery();
installPreviewWriteGuard();
// The one-shot reload guard is cleared after a successful mount (see Root.jsx),
// not here — clearing it pre-mount could let a failing initial load reload-loop.

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
    <Analytics />
  </StrictMode>,
);
