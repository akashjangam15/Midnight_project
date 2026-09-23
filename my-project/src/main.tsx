import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './styles.css';

console.log('[main.tsx] Starting app...');

const container = document.getElementById('root');
if (!container) {
  console.error('[main.tsx] Root element #root not found in index.html');
  document.body.innerHTML = '<div style="color:red;padding:20px">Error: Root element #root not found</div>';
  throw new Error('Root element #root not found in index.html');
}

try {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  console.log('[main.tsx] App rendered successfully');
} catch (err) {
  console.error('[main.tsx] Failed to render app:', err);
  document.body.innerHTML = `<div style="color:red;padding:20px">Error rendering app: ${err instanceof Error ? err.message : String(err)}</div>`;
}
