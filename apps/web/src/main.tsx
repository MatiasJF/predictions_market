import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// UI-010 is landing in stages, and every stage has to leave a working app. The new token layer
// loads first; the old stylesheet stays until the last view stops depending on it (end of stage 3),
// at which point this second import and the file both go.
import './styles/base.css';
import './styles.css';

const el = document.getElementById('root');
if (el) createRoot(el).render(<StrictMode><App /></StrictMode>);
