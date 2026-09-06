import React, { useState, useEffect } from 'react';
import { API_BASE } from '../config/api';

export default function AdminResetView() {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'loading' | 'success' | 'error'
  const [message, setMessage] = useState('');
  const [countdown, setCountdown] = useState(5);

  useEffect(() => {
    if (status === 'success') {
      const timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            window.location.href = '/'; // Redirect to main
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [status]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;

    setStatus('loading');
    try {
      const res = await fetch(`${API_BASE}/api/admin/reset-limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      
      if (data.ok) {
        setStatus('success');
        setMessage(data.message);
      } else {
        setStatus('error');
        setMessage(data.message || 'Failed to reset limit');
      }
    } catch (err) {
      setStatus('error');
      setMessage('Network error reaching backend');
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-surface-container-lowest">
      <div className="bg-surface border border-border-subtle rounded-xl shadow-2xl p-8 w-full max-w-md animate-in fade-in zoom-in duration-300">
        
        <div className="flex justify-center mb-6">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center">
            <span className="material-symbols-outlined text-[32px] text-primary">admin_panel_settings</span>
          </div>
        </div>
        
        <h2 className="text-on-surface font-bold text-2xl text-center mb-2">Admin Overload</h2>
        <p className="text-on-surface-variant text-body-sm text-center mb-8">
          Enter the secret code to bypass rate limits.
        </p>

        {status === 'success' ? (
          <div className="text-center animate-in fade-in slide-in-from-bottom-2">
            <div className="bg-[#1e4620]/30 border border-[#2e6b31] rounded-lg p-4 mb-4">
              <span className="material-symbols-outlined text-[#4caf50] text-[40px] mb-2">check_circle</span>
              <p className="text-[#81c784] font-bold">{message}</p>
            </div>
            <p className="text-on-surface-variant text-sm">
              Redirecting back to JavaFlow in <span className="font-bold text-on-surface">{countdown}</span> seconds...
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <input
                type="password"
                placeholder="Enter Secret Code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full bg-surface-container text-on-surface border border-border-subtle rounded-lg px-4 py-3 outline-none focus:border-primary transition-colors text-center tracking-widest font-mono"
                autoFocus
              />
            </div>
            
            {status === 'error' && (
              <p className="text-error text-sm text-center font-bold bg-error-container text-on-error-container py-2 rounded">
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={status === 'loading' || !code}
              className="w-full bg-primary text-on-primary hover:bg-primary-fixed disabled:opacity-50 transition-colors py-3 rounded-lg font-bold uppercase tracking-wide mt-2"
            >
              {status === 'loading' ? 'Verifying...' : 'Reset Limit'}
            </button>
            <button
              type="button"
              onClick={() => window.location.href = '/'}
              className="w-full bg-transparent text-on-surface-variant hover:text-on-surface transition-colors py-2 text-sm font-bold mt-2"
            >
              Cancel & Return
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
