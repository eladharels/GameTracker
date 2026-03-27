import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { FaCheckCircle, FaExclamationCircle, FaInfoCircle } from 'react-icons/fa';
import '../styles/Toast.css';

const ToastContext = createContext(null);
const TOAST_DURATION = 3000;
const EXIT_DURATION = 300;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef({});

  const dismissToast = useCallback((id) => {
    if (timersRef.current[id]) {
      timersRef.current[id].forEach(t => clearTimeout(t));
      delete timersRef.current[id];
    }
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, EXIT_DURATION);
  }, []);

  const showToast = useCallback((type, message, options = {}) => {
    const id = Date.now() + Math.random();
    const duration = options.duration || TOAST_DURATION;
    const actionLabel = options.actionLabel || null;
    const onAction = options.onAction || null;

    setToasts(prev => [...prev, { id, type, message, exiting: false, actionLabel, onAction }]);

    const exitTimer = setTimeout(() => {
      setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    }, duration - EXIT_DURATION);

    const removeTimer = setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
      delete timersRef.current[id];
    }, duration);

    timersRef.current[id] = [exitTimer, removeTimer];

    return id;
  }, []);

  const getIcon = (type) => {
    switch (type) {
      case 'success': return <FaCheckCircle />;
      case 'error': return <FaExclamationCircle />;
      default: return <FaInfoCircle />;
    }
  };

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      <div className="toast-container">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`toast-item toast-${toast.type}${toast.exiting ? ' toast-exiting' : ''}`}
            role="alert"
          >
            <span className="toast-icon">{getIcon(toast.type)}</span>
            <span className="toast-message">{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                className="toast-action-btn"
                onClick={() => {
                  toast.onAction();
                  dismissToast(toast.id);
                }}
              >
                {toast.actionLabel}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
