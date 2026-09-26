import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { ROUTER_PROPS } from './routerConfig'
import { ToastProvider } from './contexts/ToastContext'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter {...ROUTER_PROPS}>
      <ToastProvider>
      <App />
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
)
