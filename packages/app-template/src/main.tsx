// Ägs av mallen — appens kod ligger i App.tsx och styles.css.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { configure, createMemoryAdapter } from '@vibesandbox/sdk';
import { App } from './App.tsx';
import './styles.css';

// `npm run dev` har ingen plattform att tala med: då lagras allt i minnet, med samma regler.
// I ett produktionsbygge är villkoret falskt vid byggtid, och minnesadaptern följer inte med.
if (import.meta.env.DEV) {
  configure({ adapter: createMemoryAdapter() });
}

const root = document.getElementById('root');
if (root === null) throw new Error('index.html saknar elementet #root.');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
