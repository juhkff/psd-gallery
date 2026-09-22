import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found in index.html');

// The film-grain tile used by `.grain-overlay`. Inlined as a data URL so it costs
// no request and cannot be blocked. Kept at very low opacity in CSS - it exists to
// break up the perfectly flat glass tint, not to be noticed.
document.documentElement.style.setProperty(
  '--grain-url',
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E")`,
);

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
