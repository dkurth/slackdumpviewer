import '@fontsource/lato/400.css';
import '@fontsource/lato/400-italic.css';
import '@fontsource/lato/700.css';
import '@fontsource/lato/900.css';
import 'highlight.js/styles/github.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './App';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
